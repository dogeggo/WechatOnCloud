// VNC 音频桥接（扬声器播放）。
//
// 背景：linuxserver KasmVNC 的音频不在我们内嵌的原生 noVNC 客户端里，而在它外层的 kclient
// （容器内 nginx :3000 / → kclient :6900）通过 socket.io（路径 audio/socket.io）提供：
//   - 扬声器：服务端把 PulseAudio sink 的 PCM 通过 'audio' 事件推下来，前端用 Web Audio 播放。
// 我们没有内嵌 kclient（会破坏对原生客户端的 IME / 剪贴板 / 控制条定制），故在面板父页面直接
// 复刻它的音频客户端，连到经面板反代的 /desktop/<id>/audio/socket.io。这样还能精确控制：
//   - 「强制开启」：实例就绪即自动连接、首个用户手势后开始播放（浏览器自动播放策略所限）；
//   - 「焦点不在该实例时断开」：标签页隐藏 / 失焦 / 离开页面时关闭，避免多实例多端互相串音。

// kclient 服务端用的 socket.io 版本未知，为避免协议不匹配，动态加载它自带的 socket.io.js
// （经反代取 /desktop/<id>/audio/socket.io/socket.io.js），用全局 io，而非打包我们自己的版本。
import { ReconnectWatchdog } from './utils/connectionWatchdog';

interface AudioSocket {
  connected: boolean;
  on(event: 'audio', handler: (data: ArrayBuffer) => void): void;
  on(event: 'connect', handler: () => void): void;
  on(event: 'disconnect' | 'connect_error', handler: (reason?: unknown) => void): void;
  emit(event: 'open' | 'close', payload: string): void;
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
  private gestureBound = false;
  private resumeOnGesture: (() => void) | null = null;
  private destroyed = false;
  private connecting = false;
  private reconnectWatchdog: ReconnectWatchdog;

  constructor(id: string) {
    this.id = id;
    this.reconnectWatchdog = new ReconnectWatchdog({
      name: `vnc-audio:${id}`,
      initialDelayMs: AUDIO_RECONNECT_INITIAL_DELAY,
      maxDelayMs: AUDIO_RECONNECT_MAX_DELAY,
      reconnect: () => void this.connect(),
      shouldReconnect: () => !this.destroyed && this.active,
    });
  }

  // 建立 socket 连接（不自动出声，由 setActive 控制）。
  async connect() {
    if (this.destroyed || this.connecting) return;
    if (this.socket) {
      if (this.socket.connected) {
        if (this.active) {
          this.open();
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
        reconnection: false,
        reconnectionDelay: AUDIO_RECONNECT_INITIAL_DELAY,
        reconnectionDelayMax: AUDIO_RECONNECT_MAX_DELAY,
      });
      this.socket.on('audio', (data: ArrayBuffer) => {
        if (this.active && this.player) this.player.feed(data);
      });
      this.socket.on('connect', () => {
        this.reconnectWatchdog.reset();
        this.opened = false;
        if (this.active) {
          this.open();
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

  // 焦点变化时调用：true=本实例获得焦点（出声），false=失焦（断开播放）。
  setActive(on: boolean) {
    if (this.destroyed) return;
    this.active = on;
    if (on) {
      void this.connect();
      this.open();
    } else {
      this.reconnectWatchdog.cancel();
      this.close();
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
    this.clearResumeOnGesture();
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
      this.clearResumeOnGesture();
    };
    this.resumeOnGesture = resume;
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  private clearResumeOnGesture() {
    if (!this.resumeOnGesture) return;
    window.removeEventListener('pointerdown', this.resumeOnGesture, true);
    window.removeEventListener('keydown', this.resumeOnGesture, true);
    this.resumeOnGesture = null;
    this.gestureBound = false;
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
    this.reconnectWatchdog.schedule();
  }

  destroy() {
    this.destroyed = true;
    this.reconnectWatchdog.destroy();
    this.close();
    try {
      this.socket?.disconnect();
    } catch (error) {
      console.warn('断开 VNC 音频 socket 失败', error);
    }
    this.socket = null;
  }
}
