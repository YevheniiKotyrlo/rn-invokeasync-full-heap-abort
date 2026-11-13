import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  readonly postFromOwnThread: (
    fillJavaHeap: boolean,
    attachThreadFirst: boolean,
    onPosted: () => void,
  ) => void;
  readonly release: () => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeFullHeapPost');
