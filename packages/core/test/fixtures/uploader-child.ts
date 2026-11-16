// Uploader child for protocol tests: the real Steam adapter is never available here.
import { appendFileSync } from 'node:fs';
import { uploaderMain } from '../../src/node/index.ts';

uploaderMain({
  loadReal: () => {
    throw new Error('real Steam is not available in tests');
  },
  appendFakeLog: (path, line) => {
    appendFileSync(path, `${line}\n`);
  },
});
