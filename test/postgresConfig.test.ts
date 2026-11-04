/**
 * Pure checks for reading DATABASE_URL: no database is contacted. The address carries the password, so what these
 * prove is mostly what must NOT happen (an error or a log line repeating it). Run: npx tsx test/postgresConfig.test.ts
 */
import net from 'net';
import { PG_MIGRATIONS, pgConfigFromUrl, scrubDbText } from '../src/postgresStore';
import { openStore } from '../src/store';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`pass  ${name}`);
  }
}
function errorOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err: any) {
    return String(err?.message ?? err);
  }
}

const REMOTE = 'postgresql://postgres.abcdefgh:s3cr3t-Pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

// --- TLS choice
check('a remote host is encrypted without verifying the certificate by default', (pgConfigFromUrl(REMOTE) as any).ssl, { rejectUnauthorized: false });
check('a local host uses no TLS by default', (pgConfigFromUrl('postgresql://u:p@127.0.0.1:5432/db') as any).ssl, false);
check('localhost too', (pgConfigFromUrl('postgres://u:p@localhost/db') as any).ssl, false);
check('sslmode=disable turns TLS off even for a remote host', (pgConfigFromUrl(`${REMOTE}?sslmode=disable`) as any).ssl, false);
check('sslmode=verify-full verifies the certificate', (pgConfigFromUrl(`${REMOTE}?sslmode=verify-full`) as any).ssl, { rejectUnauthorized: true });
check('sslmode=verify-ca verifies it too', (pgConfigFromUrl(`${REMOTE}?sslmode=verify-ca`) as any).ssl, { rejectUnauthorized: true });
check('sslmode=require encrypts without verifying', (pgConfigFromUrl(`${REMOTE}?sslmode=require`) as any).ssl, { rejectUnauthorized: false });
check('the sslmode parameter is not left in the address handed to the driver', /sslmode/.test((pgConfigFromUrl(`${REMOTE}?sslmode=require`) as any).connectionString), false);
check('other parameters are kept', /application_name=x/.test((pgConfigFromUrl(`${REMOTE}?application_name=x`) as any).connectionString), true);
check('the credentials survive into the connection string the driver gets', /s3cr3t-Pw@aws-0-us-east-1/.test((pgConfigFromUrl(REMOTE) as any).connectionString), true);
check('surrounding whitespace (a pasted newline) is ignored', typeof (pgConfigFromUrl(`  ${REMOTE}\n`) as any).connectionString, 'string');

// --- refusals say what is wrong without repeating the address
const notUrl = errorOf(() => pgConfigFromUrl('not a url with s3cr3t-Pw in it'));
check('text that is not an address is refused with a sentence', /not a valid address/.test(notUrl), true);
check('...that does not repeat what was given', /s3cr3t-Pw/.test(notUrl), false);
const wrongScheme = errorOf(() => pgConfigFromUrl('mysql://u:s3cr3t-Pw@host/db'));
check('another kind of database is refused', /must start with postgresql:\/\//.test(wrongScheme), true);
check('...without repeating the address', /s3cr3t-Pw/.test(wrongScheme), false);
check('an empty value is refused', errorOf(() => pgConfigFromUrl('')) !== '', true);

// --- scrubbing text that is going to a log
check('scrub removes a whole address from a driver message', scrubDbText('connect failed for postgresql://u:s3cr3t-Pw@host:6543/db (timeout)'), 'connect failed for [database address] (timeout)');
check('scrub also handles the short scheme, in any case', scrubDbText('POSTGRES://u:pw@h/db'), '[database address]');
check('scrub removes the exact address passed in, wherever it appears', scrubDbText('bad ' + REMOTE.replace('postgresql://', '') + ' here', REMOTE.replace('postgresql://', '')), 'bad [database address] here');
check('text with no address is left alone', scrubDbText('ECONNREFUSED 127.0.0.1:5432'), 'ECONNREFUSED 127.0.0.1:5432');

// --- the schema list
check('there is at least one migration', PG_MIGRATIONS.length >= 1, true);
check('every migration is non-empty text', PG_MIGRATIONS.every((m) => typeof m === 'string' && m.trim().length > 0), true);

/**
 * A pretend PostgreSQL server that answers every connection with an error whose TEXT CONTAINS THE ADDRESS, password
 * included (a server, a pooler or a driver can do that). A real unreachable host gives a message with no secret in
 * it, so it cannot prove that the log line is scrubbed; this can.
 */
function startFakePostgres(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    let port = 0;
    const server = net.createServer((sock) => {
      sock.on('error', () => undefined);
      sock.once('data', () => {
        const text = `rejected postgresql://geo:topsecretpw@127.0.0.1:${port}/nope (password authentication failed)`;
        const fields = Buffer.concat([Buffer.from('SFATAL\0'), Buffer.from('VFATAL\0'), Buffer.from('C28P01\0'), Buffer.from(`M${text}\0`), Buffer.from('\0')]);
        const head = Buffer.alloc(5);
        head.write('E', 0);
        head.writeInt32BE(fields.length + 4, 1);
        sock.end(Buffer.concat([head, fields]));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function wiringChecks() {
  const fake = await startFakePostgres();
  try {
    const logged: string[] = [];
    const store = await openStore({ databaseUrl: `postgresql://geo:topsecretpw@127.0.0.1:${fake.port}/nope`, log: (m) => logged.push(m) });
    check('a server whose own error message contains the address and password: openStore falls back to memory', [store.info().kind, store.info().durable], ['memory', false]);
    check('...the log line has the cause (the driver said it was rejected)', logged.some((m) => /could not open the PostgreSQL database/.test(m) && /password authentication failed/.test(m)), true);
    check('...and the address, with the password, is replaced in the log line', [logged.some((m) => /topsecretpw/.test(m)), logged.some((m) => /\[database address\]/.test(m))], [false, true]);
    check('...and the public note has neither the password nor the host', /topsecretpw|127\.0\.0\.1/.test(store.info().note || ''), false);
  } finally {
    fake.close();
  }
}

wiringChecks()
  .then(() => {
    console.log(failures === 0 ? '\nAll PostgreSQL configuration checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('PostgreSQL configuration test harness error:', err);
    process.exit(1);
  });
