/** Worker thread for `npm run arena -- --jobs N`: plays the games it is sent. */
import { parentPort } from 'node:worker_threads';
import { playArenaGame, type ArenaGame } from '../src/engine/arena.js';

parentPort!.on('message', (g: ArenaGame) => parentPort!.postMessage(playArenaGame(g)));
parentPort!.postMessage('ready');
