import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { InstanceWithStatus } from '../../api';

export interface InstancesState {
  instances: InstanceWithStatus[];
  loaded: boolean;
  reload: () => Promise<void>;
  updateInstances: Dispatch<SetStateAction<InstanceWithStatus[]>>;
}

const noopReload = async () => {};
const noopUpdate: Dispatch<SetStateAction<InstanceWithStatus[]>> = () => {};

export const InstancesCtx = createContext<InstancesState>({
  instances: [],
  loaded: false,
  reload: noopReload,
  updateInstances: noopUpdate,
});

export const useInstances = () => useContext(InstancesCtx);
