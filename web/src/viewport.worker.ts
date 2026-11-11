import { SpatialIndex } from './spatialIndex';
import type { DataMessage, ViewQuery } from './spatialIndex';

let index = new SpatialIndex([]);
let connection = -1;
let version = -1;
self.onmessage = ({ data }: MessageEvent<DataMessage | ViewQuery>) => {
  if (data.type === 'data') {
    connection = data.connection;
    version = data.version;
    index = new SpatialIndex(data.features);
  } else if (data.connection === connection && data.version === version) {
    self.postMessage(index.query(data));
  }
};
