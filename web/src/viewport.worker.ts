import { SnapshotWorker } from './snapshotWorker';
import type { WorkerRequest } from './snapshotWorker';
const worker = new SnapshotWorker();
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const result = worker.receive(data);
  if (result) self.postMessage(result);
};
