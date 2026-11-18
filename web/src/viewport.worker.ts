import { SnapshotWorker } from './snapshotWorker';
import type { WorkerRequest } from './snapshotWorker';
const worker = new SnapshotWorker();
self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const result = await worker.receive(data);
  if (result) self.postMessage(result);
};
