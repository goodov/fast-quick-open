import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { getFzfPath } from '../binaries.ts';

const fzfPath = getFzfPath(path.join(__dirname, '..', '..'));

const NAMED = '0/App/./src/foo.ts';
const EMPTY = '1//./lib/bar.ts';

function filter(query: string): string[] {
  const result = spawnSync(
    fzfPath,
    [
      '--read0',
      '--delimiter',
      '/',
      '--nth',
      '2..',
      '--scheme=path',
      '--filter',
      query,
    ],
    { input: `${NAMED}\0${EMPTY}\0`, encoding: 'utf8' },
  );
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr || `fzf exit ${result.status}`,
  );
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

suite('fzf labeled vs empty // matching', function () {
  suiteSetup(function () {
    if (!fs.existsSync(fzfPath)) {
      this.skip();
    }
  });

  test('App/src matches the named group only', () => {
    assert.deepStrictEqual(filter('App/src'), [NAMED]);
  });

  test('lib/ matches the empty-label path only', () => {
    assert.deepStrictEqual(filter('lib/'), [EMPTY]);
  });

  test('// matches the empty-label line (named also matches via /./)', () => {
    const hits = filter('//');
    assert.ok(
      hits.includes(EMPTY),
      `missing empty-label hit: ${hits.join(',')}`,
    );
    assert.ok(
      hits.includes(NAMED),
      `named /./ fuzzy-matches //: ${hits.join(',')}`,
    );
  });
});
