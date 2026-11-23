/** Releases: kinds, milestone and sprints, the version from the code, and how each release reaches people. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultChecklist, nextVersion, parseSemver, versionInFile } from '../src/services/releases';
import { type Json, makeHarness } from './harness';

describe('versions', () => {
  it('reads the version from the usual files', () => {
    expect(versionInFile('package.json', '{"name":"x","version":"2.3.1"}')).toBe('2.3.1');
    expect(versionInFile('src/App/App.csproj', '<Project><PropertyGroup><Version>1.4.0</Version></PropertyGroup></Project>')).toBe('1.4.0');
    expect(versionInFile('Properties/AssemblyInfo.cs', '[assembly: AssemblyFileVersion("3.0.2.0")]')).toBe('3.0.2.0');
    expect(versionInFile('pubspec.yaml', 'name: ludo\nversion: 1.2.3+45\n')).toBe('1.2.3');
    expect(versionInFile('app/build.gradle', 'defaultConfig {\n versionCode 12\n versionName "1.0.7"\n}')).toBe('1.0.7');
    expect(versionInFile('app/build.gradle.kts', 'versionName = "2.1.0"')).toBe('2.1.0');
    expect(versionInFile('ios/Runner/Info.plist', '<key>CFBundleShortVersionString</key>\n\t<string>4.5.6</string>')).toBe('4.5.6');
    expect(versionInFile('pyproject.toml', '[project]\nname = "x"\nversion = "0.9.0"')).toBe('0.9.0');
    expect(versionInFile('VERSION', 'v5.0.1\n')).toBe('5.0.1');
    expect(versionInFile('README.md', 'version 1')).toBeNull();
  });

  it('works out the next version for each kind of release', () => {
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(nextVersion('1.4.2', 'minor')).toBe('1.5.0');
    expect(nextVersion('1.4.2', 'patch')).toBe('1.4.3');
    expect(nextVersion('v1.4.2', 'hotfix')).toBe('1.4.3');
    expect(nextVersion('1.4.2', 'prerelease')).toBe('1.5.0-beta.1');
    expect(nextVersion('1.5.0-beta.1', 'prerelease')).toBe('1.5.0-beta.2');
    expect(nextVersion('1.5.0-beta.2', 'patch')).toBe('1.5.0');
    expect(nextVersion(null, 'minor')).toBe('0.1.0');
    expect(parseSemver('3.0.2.0')).toMatchObject({ major: 3, minor: 0, patch: 2 });
  });

  it('starts each channel with the steps it usually needs', () => {
    expect(defaultChecklist('android', 'play_store').map((x) => x.label)).toContain('Data safety form and privacy policy URL');
    expect(defaultChecklist('windows', 'email')[0]!.label).toMatch(/Installer built/);
    expect(defaultChecklist('web', 'deploy').some((x) => /Smoke-tested/.test(x.label))).toBe(true);
  });
});

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_releases');
  await h.signup('relco', 'owner@relco.test');
  api = h.as('relco', (await h.login('relco', 'owner@relco.test')).token);
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
}, 120_000);

describe('releases of an in-house product', () => {
  it('an in-house mobile game, with no customer', async () => {
    const p = await api('POST', '/api/v1/records/project', { name: 'LudoVerse', project_kind: 'in_house', product_type: 'mobile_game', billing_method: 'non_billable' });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    ids.project = p.json.id;
    const g = (await api('GET', `/api/v1/records/project/${ids.project}`)).json;
    expect(g).toMatchObject({ project_kind: 'in_house', product_type: 'mobile_game', account_id: null });
    expect((await api('POST', '/api/v1/records/project', { name: 'x', product_type: 'spaceship' })).status).toBe(400);
    expect((await api('GET', `/api/v1/projects/${ids.project}`)).json.project).toMatchObject({ project_kind: 'in_house', product_type: 'mobile_game' });
    const list = (await api('GET', '/api/v1/projects')).json as Json[];
    expect(list.find((x) => x.id === ids.project)).toMatchObject({ project_kind: 'in_house', product_type: 'mobile_game' });
  });

  it('a minor release delivering a milestone, fed by sprints, shipped to Play, the App Store and as a Windows installer', async () => {
    ids.ms = (await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Online multiplayer' })).json.id;
    const s1 = await api('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'Sprint 1', startDate: '2026-11-02', endDate: '2026-11-13' });
    const s2 = await api('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'Sprint 2', startDate: '2026-11-16', endDate: '2026-11-27' });
    expect(s1.status, JSON.stringify(s1.json)).toBe(201);
    // no repository yet: the version starts from the last release (none) and says why
    const v = (await api('GET', `/api/v1/projects/${ids.project}/agile/release-version`)).json;
    expect(v).toMatchObject({ current: null, next: { minor: '0.1.0', major: '1.0.0', hotfix: '0.0.1' } });
    expect(v.note).toMatch(/No repository/);
    const r = await api('POST', `/api/v1/projects/${ids.project}/agile/releases`, { name: 'Multiplayer', version: '1.1.0', releaseType: 'minor', milestoneId: ids.ms, sprintIds: [s1.json.id, s2.json.id], versionSource: 'pubspec.yaml' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.rel = r.json.id;
    const board = (await api('GET', `/api/v1/projects/${ids.project}/agile`)).json;
    const rel = board.releases.find((x: Json) => x.id === ids.rel);
    expect(rel).toMatchObject({ release_type: 'minor', milestone: 'Online multiplayer', version_source: 'pubspec.yaml' });
    expect(rel.sprint_ids.sort()).toEqual([s1.json.id, s2.json.id].sort());

    // how it goes out
    const play = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/channels`, { platform: 'android', method: 'play_store', target: 'Closed testing', buildRef: 'versionCode 12' });
    expect(play.status, JSON.stringify(play.json)).toBe(201);
    await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/channels`, { platform: 'ios', method: 'testflight', status: 'in_review' });
    const win = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/channels`, { platform: 'windows', method: 'onedrive', url: 'https://1drv.ms/u/s!abc', recipients: 'deepak@fci.gov.in' });
    let d = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}`)).json;
    expect(d.channels.map((c: Json) => [c.platform, c.method, c.status])).toEqual([
      ['android', 'play_store', 'planned'],
      ['ios', 'testflight', 'in_review'],
      ['windows', 'onedrive', 'planned'],
    ]);
    expect(d.channels[0].checklist.length).toBeGreaterThan(5);
    expect(d.sprints).toHaveLength(2);
    // ticked off and live
    const cl = d.channels[2].checklist.map((x: Json) => ({ ...x, done: true }));
    const done = await api('PUT', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/channels/${win.json.id}`, { platform: 'windows', method: 'onedrive', url: 'https://1drv.ms/u/s!abc', recipients: 'deepak@fci.gov.in', checklist: cl, status: 'done' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    d = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}`)).json;
    expect(d.channels[2]).toMatchObject({ status: 'done' });
    expect(d.channels[2].done_at).toBeTruthy();
    // files must be the project's
    expect((await api('PUT', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/channels/${win.json.id}`, { platform: 'windows', method: 'onedrive', fileIds: ['01a1e32d-fd14-7301-87b8-6945b32a2f8e'] })).status).toBe(400);
    expect((await api('DELETE', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/channels/${play.json.id}`)).status).toBe(200);
    // released: the next minor starts from it
    expect((await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.rel}/release`, {})).status).toBe(200);
    expect((await api('GET', `/api/v1/projects/${ids.project}/agile/release-version`)).json).toMatchObject({ current: '1.1.0', lastRelease: '1.1.0', next: { minor: '1.2.0', hotfix: '1.1.1' } });
  });
});
