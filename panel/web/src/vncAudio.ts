// VNC 音频/麦克风桥接（扬声器 + 麦克风）。
//
// 背景：linuxserver KasmVNC 的音频不在我们内嵌的原生 noVNC 客户端里，而在它外层的 kclient
// （容器内 nginx :3000 / → kclient :6900）通过 socket.io（路径 audio/socket.io）提供：
//   - 扬声器：服务端把 PulseAudio sink 的 PCM 通过 'audio' 事件推下来，前端用 Web Audio 播放；
//   - 麦克风：前端采集 Int16 通过 'micdata' 事件上传，服务端灌进 PulseAudio。
// 我们没有内嵌 kclient（会破坏对原生客户端的 IME / 剪贴板 / 控制条定制），故在面板父页面直接
// 复刻它的音频客户端，连到经面板反代的 /desktop/<id>/audio/socket.io。这样还能精确控制：
//   - 「强制开启」：实例就绪即自动连接、首个用户手势后开始播放（浏览器自动播放策略所限）；
//   - 「焦点不在该实例时断开」：标签页隐藏 / 失焦 / 离开页面时关闭，避免多实例多端互相串音。
//
// 麦克风需要「安全上下文」(HTTPS 或 localhost) 才有 getUserMedia；局域网 http 下浏览器禁用，
// 此时自动跳过麦克风、只保留扬声器。

// kclient 服务端用的 socket.io 版本未知，为避免协议不匹配，动态加载它自带的 socket.io.js
// （经反代取 /desktop/<id>/audio/socket.io/socket.io.js），用全局 io，而非打包我们自己的版本。
interface AudioSocket {
  connected: boolean;
  on(event: 'audio', handler: (data: ArrayBuffer) => void): void;
  on(event: 'connect', handler: () => void): void;
  on(event: 'disconnect' | 'connect_error', handler: (reason?: unknown) => void): void;
  emit(event: 'open' | 'close', payload: string): void;
  emit(event: 'micdata', payload: ArrayBuffer): void;
  connect?: () => void;
  open?: () => void;
  disconnect(): void;
}

interface SocketIoFactory {
  (
    origin: string,
    options: {
      path: string;
      transports: string[];
      withCredentials: boolean;
      reconnection: boolean;
      reconnectionDelay: number;
      reconnectionDelayMax: number;
    },
  ): AudioSocket;
}

interface SocketIoWindow extends Window {
  io?: SocketIoFactory;
  AudioContext?: new (options?: AudioContextOptions) => AudioContext;
  webkitAudioContext?: new (options?: AudioContextOptions) => AudioContext;
}

interface SocketIoScript extends HTMLScriptElement {
  _wocPromise?: Promise<SocketIoFactory>;
}

const AUDIO_RECONNECT_INITIAL_DELAY = 1000;
const AUDIO_RECONNECT_MAX_DELAY = 10000;

function audioContextCtor(): new (options?: AudioContextOptions) => AudioContext {
  const win = window as SocketIoWindow;
  const Ctx = win.AudioContext || win.webkitAudioContext;
  if (!Ctx) throw new Error('当前浏览器不支持 AudioContext');
  return Ctx;
}

function isExpectedMicUnavailableError(error: unknown): boolean {
  const name =
    error instanceof DOMException
      ? error.name
      : error && typeof error === 'object' && 'name' in error
        ? String((error as { name: unknown }).name)
        : '';
  return (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    name === 'SecurityError'
  );
}

function loadIo(id: string): Promise<SocketIoFactory> {
  const w = window as SocketIoWindow;
  if (w.io) return Promise.resolve(w.io);
  const existing = document.getElementById('woc-socketio') as SocketIoScript | null;
  if (existing?._wocPromise) {
    return existing._wocPromise.catch((error) => {
      existing._wocPromise = undefined;
      existing.remove();
      throw error;
    });
  }
  const s = document.createElement('script') as SocketIoScript;
  s.id = 'woc-socketio';
  s.src = `/desktop/${encodeURIComponent(id)}/audio/socket.io/socket.io.js`;
  const p = new Promise<SocketIoFactory>((resolve, reject) => {
    s.onload = () => {
      if (w.io) {
        resolve(w.io);
        return;
      }
      s._wocPromise = undefined;
      s.remove();
      reject(new Error('io 未就绪'));
    };
    s.onerror = () => {
      s._wocPromise = undefined;
      s.remove();
      reject(new Error('加载 socket.io 失败'));
    };
  });
  s._wocPromise = p;
  document.head.appendChild(s);
  return p;
}

// PCM 播放器：忠实复刻 kclient 的解码/调度（Int16 立体声 @ 44100 → Web Audio），
// 这套参数与服务端音频格式匹配，改动易出杂音，故照搬。
class PcmPlayer {
  audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private startTime = 0;
  private buffer: Float32Array = new Float32Array(0);
  private playing = false;
  private lock = false;
  private resetTimer: number | undefined;

  init() {
    const Ctx = audioContextCtor();
    this.audioCtx = new Ctx({ sampleRate: 44100 });
    void this.audioCtx.resume().catch((error) => console.warn('恢复音频播放失败', error));
    this.gain = this.audioCtx!.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.audioCtx!.destination);
    this.startTime = this.audioCtx!.currentTime;
    // 与 kclient 一致：100ms 内无新数据则清空缓冲，避免拖尾/堆积
    this.resetTimer = window.setInterval(() => {
      if (this.playing) {
        if (!this.lock) {
          this.buffer = new Float32Array(0);
          this.playing = false;
        }
        this.lock = false;
      }
    }, 100);
  }

  feed(data: ArrayBuffer) {
    if (!this.audioCtx) return;
    this.lock = true;
    const i16 = new Int16Array(data);
    const f32 = Float32Array.from(i16, (x) => x / 32767);
    const merged = new Float32Array(this.buffer.length + f32.length);
    merged.set(this.buffer);
    merged.set(f32, this.buffer.length);
    this.buffer = merged;
    const frames = this.buffer.length / 2; // 立体声
    const duration = frames / 44100 / 2; // 与 kclient 的 buffAudio.duration/2 等价
    if (duration > 0.05 || this.playing) {
      this.playing = true;
      const buffAudio = this.audioCtx.createBuffer(2, this.buffer.length, 44100);
      const left = buffAudio.getChannelData(0);
      const right = buffAudio.getChannelData(1);
      let bc = 0;
      let off = 1;
      for (let i = 0; i < frames; i++) {
        left[i] = this.buffer[bc];
        bc += 2;
        right[i] = this.buffer[off];
        off += 2;
      }
      this.buffer = new Float32Array(0);
      if (this.startTime < this.audioCtx.currentTime) this.startTime = this.audioCtx.currentTime;
      const src = this.audioCtx.createBufferSource();
      src.buffer = buffAudio;
      src.connect(this.gain!);
      src.start(this.startTime);
      this.startTime += buffAudio.duration / 2;
    }
  }

  destroy() {
    if (this.resetTimer) window.clearInterval(this.resetTimer);
    this.resetTimer = undefined;
    this.buffer = new Float32Array(0);
    this.playing = false;
    try {
      this.audioCtx?.close();
    } catch (error) {
      console.warn('关闭音频播放器失败', error);
    }
    this.audioCtx = null;
    this.gain = null;
  }
}

export class VncAudio {
  private id: string;
  private socket: AudioSocket | null = null;
  private player: PcmPlayer | null = null;
  private active = false; // 当前实例是否处于"焦点中"（应出声）
  private opened = false; // 是否已对服务端 emit('open')
  private micStream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private micNode: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStarting = false;
  private micUnavailable = false;
  private micDeviceChangeBound = false;
  private gestureBound = false;
  private destroyed = false;
  private connecting = false;
  private reconnectTimer: number | undefined;
  private reconnectDelay = AUDIO_RECONNECT_INITIAL_DELAY;
  private readonly resetMicAvailability = () => {
    this.micUnavailable = false;
  };

  constructor(id: string) {
    this.id = id;
  }

  // 建立 socket 连接（不自动出声，由 setActive 控制）。
  async connect() {
    if (this.destroyed || this.connecting) return;
    if (this.socket) {
      if (this.socket.connected) {
        if (this.active) {
          this.open();
          void this.startMic();
        }
      } else {
        this.requestSocketConnect();
      }
      return;
    }

    this.connecting = true;
    try {
      const io = await loadIo(this.id);
      if (this.destroyed) return;
      this.socket = io(window.location.origin, {
        path: `/desktop/${this.id}/audio/socket.io`,
        transports: ['websocket', 'polling'],
        withCredentials: true,
        reconnection: true,
        reconnectionDelay: AUDIO_RECONNECT_INITIAL_DELAY,
        reconnectionDelayMax: AUDIO_RECONNECT_MAX_DELAY,
      });
      this.socket.on('audio', (data: ArrayBuffer) => {
        if (this.active && this.player) this.player.feed(data);
      });
      this.socket.on('connect', () => {
        this.clearReconnectTimer();
        this.reconnectDelay = AUDIO_RECONNECT_INITIAL_DELAY;
        this.opened = false;
        if (this.active) {
          this.open();
          void this.startMic();
        }
      });
      this.socket.on('disconnect', () => {
        this.opened = false;
        if (this.active) this.scheduleReconnect();
      });
      this.socket.on('connect_error', () => {
        if (this.active) this.scheduleReconnect();
      });
    } catch (error) {
      if (!this.destroyed) {
        console.warn('连接 VNC 音频 socket 失败', error);
        this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  // 焦点变化时调用：true=本实例获得焦点（出声+收音），false=失焦（断开设备）。
  setActive(on: boolean) {
    if (this.destroyed) return;
    this.active = on;
    if (on) {
      void this.connect();
      this.open();
      void this.startMic();
    } else {
      this.close();
      this.stopMic();
    }
  }

  private open() {
    if (!this.socket || !this.socket.connected) return;
    if (!this.opened) {
      this.socket.emit('open', '');
      this.opened = true;
    }
    if (!this.player) {
      this.player = new PcmPlayer();
      this.player.init();
    }
    this.ensureResumeOnGesture();
  }

  private close() {
    if (this.socket && this.opened) {
      try {
        this.socket.emit('close', '');
      } catch (error) {
        console.warn('关闭 VNC 音频通道失败', error);
      }
    }
    this.opened = false;
    this.player?.destroy();
    this.player = null;
  }

  // 浏览器自动播放策略：AudioContext 常被挂起，需用户手势恢复。绑定一次性手势监听，
  // 用户点进画面/按键时自动 resume，实现"无需手动点工具条即可出声"。
  private ensureResumeOnGesture() {
    const ctx = this.player?.audioCtx;
    if (!ctx) return;
    if (ctx.state !== 'suspended' || this.gestureBound) return;
    this.gestureBound = true;
    const resume = () => {
      void this.player?.audioCtx?.resume().catch((error) => console.warn('恢复音频上下文失败', error));
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      this.gestureBound = false;
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  private async startMic() {
    // 麦克风需安全上下文（HTTPS / localhost）；http 局域网下静默跳过，只保留扬声器。
    if (this.micCtx || this.micStarting || this.micUnavailable || !this.socket || !this.socket.connected) return;
    const md = navigator.mediaDevices;
    if (!window.isSecureContext || !md || !md.getUserMedia) return;
    this.watchMicDevices(md);
    this.micStarting = true;
    try {
      if (!(await this.hasAudioInputDevice(md))) {
        this.micUnavailable = true;
        return;
      }
      const stream = await md.getUserMedia({ audio: true });
      if (this.destroyed || !this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.micStream = stream;
      const Ctx = audioContextCtor();
      this.micCtx = new Ctx();
      this.micSource = this.micCtx!.createMediaStreamSource(stream);
      this.micNode = this.micCtx!.createScriptProcessor(512, 1, 1);
      this.micSource.connect(this.micNode);
      this.micNode.connect(this.micCtx!.destination);
      this.micNode.onaudioprocess = (e) => {
        if (!this.active || !this.socket?.connected) return;
        const input = e.inputBuffer.getChannelData(0);
        // 简单能量门限：近乎静音不上传，省带宽（替代 kclient 的 JSON.size 启发式）
        let peak = 0;
        for (let i = 0; i < input.length; i++) {
          const a = input[i] < 0 ? -input[i] : input[i];
          if (a > peak) peak = a;
        }
        if (peak < 0.01) return;
        const i16 = Int16Array.from(input, (x) => Math.max(-32768, Math.min(32767, x * 32767)));
        this.socket.emit('micdata', i16.buffer);
      };
    } catch (error) {
      if (isExpectedMicUnavailableError(error)) {
        this.micUnavailable = true;
        return;
      }
      console.warn('启动麦克风桥接失败', error);
      this.stopMic();
    } finally {
      this.micStarting = false;
    }
  }

  private async hasAudioInputDevice(md: MediaDevices): Promise<boolean> {
    if (!md.enumerateDevices) return true;
    const devices = await md.enumerateDevices();
    return devices.some((device) => device.kind === 'audioinput');
  }

  private watchMicDevices(md: MediaDevices) {
    if (this.micDeviceChangeBound) return;
    md.addEventListener('devicechange', this.resetMicAvailability);
    this.micDeviceChangeBound = true;
  }

  private unwatchMicDevices() {
    if (!this.micDeviceChangeBound) return;
    navigator.mediaDevices?.removeEventListener('devicechange', this.resetMicAvailability);
    this.micDeviceChangeBound = false;
  }

  private stopMic() {
    try {
      if (this.micNode) this.micNode.onaudioprocess = null;
      this.micNode?.disconnect();
      this.micSource?.disconnect();
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micCtx?.close();
    } catch (error) {
      console.warn('停止麦克风桥接失败', error);
    }
    this.micNode = null;
    this.micSource = null;
    this.micStream = null;
    this.micCtx = null;
  }

  private requestSocketConnect() {
    try {
      const connect = this.socket?.connect ?? this.socket?.open;
      connect?.call(this.socket);
    } catch (error) {
      console.warn('重连 VNC 音频 socket 失败', error);
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, AUDIO_RECONNECT_MAX_DELAY);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  destroy() {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.close();
    this.stopMic();
    this.unwatchMicDevices();
    try {
      this.socket?.disconnect();
    } catch (error) {
      console.warn('断开 VNC 音频 socket 失败', error);
    }
    this.socket = null;
  }
}
