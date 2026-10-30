import http from 'node:http';
import { boot } from './boot.js';

const { handler, port, onListening } = await boot();
http.createServer(handler).listen(port, onListening);
