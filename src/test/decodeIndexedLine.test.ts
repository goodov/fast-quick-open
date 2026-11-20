import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

import { type FdCommandSpec } from '../fdCommand.ts';
import {
  buildFzfArgs,
  decodeIndexedLine,
  fzfNthForBuild,
} from '../fzfIndex.ts';

function spec(base: string, filterLabel?: string): FdCommandSpec {
  return { command: [], base, filterLabel };
}

suite('decodeIndexedLine', () => {
  const external = path.join(os.tmpdir(), 'user', 'brave');
  const inTree = path.join(os.tmpdir(), 'ws', 'brave');
  const specs = [spec(external), spec(inTree)];

  test('maps N/rel to the matching spec base as root', () => {
    const hit = decodeIndexedLine('0/foo/a.ts', specs);
    assert.ok(hit);
    assert.strictEqual(hit.root, external);
    assert.strictEqual(
      hit.path,
      path.normalize(path.join(external, 'foo/a.ts')),
    );

    const other = decodeIndexedLine('1/foo/a.ts', specs);
    assert.ok(other);
    assert.strictEqual(other.root, inTree);
    assert.strictEqual(
      other.path,
      path.normalize(path.join(inTree, 'foo/a.ts')),
    );
  });

  test('does not infer root by path: same relative file stays on its group', () => {
    const hit = decodeIndexedLine('0/renderer/x.ts', specs);
    assert.strictEqual(hit?.root, external);
    const other = decodeIndexedLine('1/renderer/x.ts', specs);
    assert.strictEqual(other?.root, inTree);
  });

  test('rejects missing index, empty relative, and out-of-range groups', () => {
    assert.strictEqual(decodeIndexedLine('foo/a.ts', specs), undefined);
    assert.strictEqual(decodeIndexedLine('0/', specs), undefined);
    assert.strictEqual(decodeIndexedLine('2/foo.ts', specs), undefined);
    assert.strictEqual(decodeIndexedLine('-1/foo.ts', specs), undefined);
  });

  test('unlabeled ./rel joins as a path under the spec base', () => {
    const hit = decodeIndexedLine('0/./src/a.ts', specs);
    assert.ok(hit);
    assert.strictEqual(hit.root, external);
    assert.strictEqual(
      hit.path,
      path.normalize(path.join(external, 'src/a.ts')),
    );
  });

  test('strips Name before the fd-relative ./path', () => {
    const labeled = [spec(external, 'user/brave'), spec(inTree, 'ws')];
    const hit = decodeIndexedLine('1/ws/./src/a.ts', labeled);
    assert.ok(hit);
    assert.strictEqual(hit.root, inTree);
    assert.strictEqual(hit.path, path.normalize(path.join(inTree, 'src/a.ts')));
  });

  test('strips a filter label that contains slashes', () => {
    const labeled = [spec(inTree, 'My/App')];
    const hit = decodeIndexedLine('0/My/App/./foo/a.ts', labeled);
    assert.ok(hit);
    assert.strictEqual(hit.path, path.normalize(path.join(inTree, 'foo/a.ts')));
  });

  test('strips an empty filter label from N//./rel', () => {
    const labeled = [spec(external, ''), spec(inTree, 'ws')];
    const hit = decodeIndexedLine('0//./src/a.ts', labeled);
    assert.ok(hit);
    assert.strictEqual(hit.root, external);
    assert.strictEqual(
      hit.path,
      path.normalize(path.join(external, 'src/a.ts')),
    );
  });

  test('rejects an empty-label line that is missing the extra slash', () => {
    const labeled = [spec(external, '')];
    assert.strictEqual(decodeIndexedLine('0/./src/a.ts', labeled), undefined);
  });

  test('rejects a line whose label does not match the spec', () => {
    const labeled = [spec(inTree, 'ws')];
    assert.strictEqual(
      decodeIndexedLine('0/other/./src/a.ts', labeled),
      undefined,
    );
  });
});

suite('fzfNthForBuild', () => {
  test('unlabeled indexes keep 3..', () => {
    assert.strictEqual(fzfNthForBuild({ filterLabels: false }), '3..');
  });

  test('labeled indexes use 2.. so Name/path is consecutive', () => {
    assert.strictEqual(fzfNthForBuild({ filterLabels: true }), '2..');
  });

  test('buildFzfArgs writes the nth expression', () => {
    const args = buildFzfArgs(undefined, '2..');
    const nth = args.indexOf('--nth');
    assert.ok(nth >= 0);
    assert.strictEqual(args[nth + 1], '2..');
    assert.ok(args.includes('--headless'));
    assert.strictEqual(args[args.indexOf('--listen') + 1], '127.0.0.1:0');
  });
});
