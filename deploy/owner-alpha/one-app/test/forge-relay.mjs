// Two fixed endpoints, used only by the hermetic release fixture. This keeps
// the publisher's loopback separate from the node's, without admitting egress.
import { createConnection, createServer } from 'node:net';

const tcp = { host: '127.0.0.1', port: 48080 };
const unix = { path: '/lab-relay/forge.sock' };
const toTcp = process.argv[2] === 'to-tcp';
if (!toTcp && process.argv[2] !== 'to-unix') process.exit(2);
createServer((incoming) => {
  const outgoing = createConnection(toTcp ? tcp : unix);
  incoming.on('error', () => outgoing.destroy());
  outgoing.on('error', () => incoming.destroy());
  incoming.pipe(outgoing).pipe(incoming);
}).listen(toTcp ? unix : tcp);
