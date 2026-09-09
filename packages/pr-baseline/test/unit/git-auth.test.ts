import { describe, expect, it } from 'vitest';
import {
	GitError,
	gitAuthConfig,
	gitBaseEnv,
	isSuspiciousSetting,
	redactUserinfo,
	remoteUrlServes,
	scrubSecrets,
	transportOf,
} from '../../src/git/repo.ts';

describe('gitAuthConfig', () => {
	it('authenticates the permitted server, clearing any inherited header for it first', () => {
		const entries = gitAuthConfig(
			'https://github.com/acme/widgets.git',
			'secret',
			'https://github.com',
		);
		expect(entries).toEqual([
			['http.https://github.com/.extraheader', ''],
			[
				'http.https://github.com/.extraheader',
				`AUTHORIZATION: basic ${Buffer.from('x-access-token:secret').toString('base64')}`,
			],
		]);
		expect(
			gitAuthConfig('https://GHE.test/acme/widgets', 'secret', 'https://ghe.test/')[1]?.[0],
		).toBe('http.https://ghe.test/.extraheader');
	});

	it('sends the token to no other host, scheme, or without a server', () => {
		expect(
			gitAuthConfig('https://evil.example/acme/widgets.git', 'secret', 'https://github.com'),
		).toEqual([]);
		expect(
			gitAuthConfig('git@github.com:acme/widgets.git', 'secret', 'https://github.com'),
		).toEqual([]);
		expect(gitAuthConfig('file:///tmp/remote', 'secret', 'https://github.com')).toEqual([]);
		expect(
			gitAuthConfig('https://github.com/acme/widgets', undefined, 'https://github.com'),
		).toEqual([]);
		expect(gitAuthConfig('https://github.com/acme/widgets', 'secret', undefined)).toEqual([]);
	});
});

describe('remoteUrlServes', () => {
	it('accepts only the exact repository on the permitted server for http(s) remotes', () => {
		expect(
			remoteUrlServes('https://github.com/acme/widgets.git', 'acme/widgets', 'https://github.com'),
		).toBe(true);
		expect(
			remoteUrlServes('https://github.com/Acme/Widgets/', 'acme/widgets', 'https://github.com'),
		).toBe(true);
		expect(
			remoteUrlServes(
				'https://evil.example/acme/widgets.git',
				'acme/widgets',
				'https://github.com',
			),
		).toBe(false);
		expect(
			remoteUrlServes(
				'https://github.com/mirror/acme/widgets',
				'acme/widgets',
				'https://github.com',
			),
		).toBe(false);
		expect(
			remoteUrlServes('https://github.com/acme/widgets-fork', 'acme/widgets', 'https://github.com'),
		).toBe(false);
	});

	it('matches ssh and file remotes by path only', () => {
		expect(
			remoteUrlServes('git@github.com:acme/widgets.git', 'acme/widgets', 'https://github.com'),
		).toBe(true);
		expect(remoteUrlServes('file:///tmp/acme/widgets', 'acme/widgets', 'https://github.com')).toBe(
			true,
		);
		expect(remoteUrlServes('file:///tmp/other/widgets', 'acme/widgets', 'https://github.com')).toBe(
			false,
		);
	});
});

describe('gitBaseEnv', () => {
	it('drops every copy of the token and inherited config, and hardens git', () => {
		const env = gitBaseEnv(
			{
				GITHUB_TOKEN: 'secret',
				INPUT_TOKEN: 'secret',
				GIT_CONFIG_COUNT: '10',
				PATH: '/bin',
				LANG: 'de_DE',
			},
			{ token: 'secret', offline: true },
			[['http.https://github.com/.extraheader', 'AUTHORIZATION: basic x']],
		);
		expect(Object.values(env)).not.toContain('secret');
		expect(env).toMatchObject({
			PATH: '/bin',
			LC_ALL: 'C',
			LANG: 'C',
			GIT_NO_REPLACE_OBJECTS: '1',
			GIT_NO_LAZY_FETCH: '1',
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_COUNT: '8',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/dev/null',
			GIT_CONFIG_KEY_1: 'push.gpgSign',
			GIT_CONFIG_VALUE_1: 'false',
			GIT_CONFIG_KEY_2: 'credential.helper',
			GIT_CONFIG_VALUE_2: '',
			GIT_CONFIG_KEY_7: 'http.https://github.com/.extraheader',
			GIT_CONFIG_VALUE_7: 'AUTHORIZATION: basic x',
		});
	});

	it('never adopts a transport-helper remote, whatever the helper is called', () => {
		expect(
			remoteUrlServes('ext::sh -c evil acme/widgets', 'acme/widgets', 'https://github.com'),
		).toBe(false);
		expect(
			remoteUrlServes('evil_helper::/tmp/acme/widgets', 'acme/widgets', 'https://github.com'),
		).toBe(false);
		expect(remoteUrlServes('fd::17/acme/widgets', 'acme/widgets', 'https://github.com')).toBe(
			false,
		);
		expect(remoteUrlServes('https://[::1]/acme/widgets', 'acme/widgets', 'https://[::1]')).toBe(
			true,
		);
	});
});

describe('askpass', () => {
	it('is disabled for every git the adapter runs', () => {
		const env = gitBaseEnv({ GIT_ASKPASS: '/usr/bin/evil', SSH_ASKPASS: '/usr/bin/evil' }, {});
		expect(env['GIT_ASKPASS']).toBe('');
		expect(env['SSH_ASKPASS']).toBe('');
		expect(Object.values(env)).toContain('credential.interactive');
	});
});

describe('transportOf', () => {
	it('names the transport git may use', () => {
		expect(transportOf('https://github.com/acme/widgets.git')).toBe('https');
		expect(transportOf('http://ghe.test/acme/widgets')).toBe('http');
		expect(transportOf('file:///tmp/acme/widgets')).toBe('file');
		expect(transportOf('/tmp/acme/widgets')).toBe('file');
		expect(transportOf('git@github.com:acme/widgets.git')).toBe('ssh');
		expect(transportOf('ssh://git@github.com/acme/widgets')).toBe('ssh');
		expect(transportOf('ext::sh -c evil')).toBeNull();
		expect(gitBaseEnv({}, { allowProtocol: 'https' })['GIT_ALLOW_PROTOCOL']).toBe('https');
		expect(gitBaseEnv({}, {})['GIT_ALLOW_PROTOCOL']).toBe('');
	});
});

describe('ssh remote forms', () => {
	it('recognizes host aliases without a user and refuses unnameable transports', () => {
		expect(transportOf('github-work:acme/widgets.git')).toBe('ssh');
		expect(transportOf('github.com:acme/widgets.git')).toBe('ssh');
		expect(
			remoteUrlServes('github-work:acme/widgets.git', 'acme/widgets', 'https://github.com'),
		).toBe(true);
		expect(remoteUrlServes('weird', 'acme/widgets', 'https://github.com')).toBe(false);
		const env = gitBaseEnv(
			{ GIT_SSL_NO_VERIFY: '1', GIT_PROXY_COMMAND: 'x', HTTPS_PROXY: 'p' },
			{},
		);
		expect(env['GIT_SSL_NO_VERIFY']).toBeUndefined();
		expect(env['GIT_PROXY_COMMAND']).toBeUndefined();
		expect(env['HTTPS_PROXY']).toBe('p');
	});
});

describe('alternates', () => {
	it('drops GIT_ALTERNATE_OBJECT_DIRECTORIES', () => {
		expect(
			gitBaseEnv({ GIT_ALTERNATE_OBJECT_DIRECTORIES: '/x' }, {})[
				'GIT_ALTERNATE_OBJECT_DIRECTORIES'
			],
		).toBeUndefined();
	});
});

describe('URL hygiene', () => {
	it('refuses credentials in an http(s) remote and redacts them from messages', () => {
		expect(
			remoteUrlServes(
				'https://x-access-token:secret@github.com/acme/widgets.git',
				'acme/widgets',
				'https://github.com',
			),
		).toBe(false);
		expect(redactUserinfo('fatal: https://x-access-token:secret@github.com/a failed')).toBe(
			'fatal: https://***@github.com/a failed',
		);
	});

	it('flags settings that steer an authenticated fetch and tolerates the rest', () => {
		const url = 'https://github.com/acme/widgets.git';
		expect(isSuspiciousSetting('http.sslverify', url)).toBe(true);
		expect(isSuspiciousSetting('http.https://github.com/.extraheader', url)).toBe(false);
		expect(isSuspiciousSetting(`remote.${url}.url`, url)).toBe(true);
		expect(isSuspiciousSetting(`remote.${url}.vcs`, url)).toBe(true);
		expect(isSuspiciousSetting(`remote.${url}.promisor`, url)).toBe(false);
		expect(isSuspiciousSetting(`remote.${url}.partialclonefilter`, url)).toBe(false);
		expect(isSuspiciousSetting('remote.origin.proxy', url)).toBe(true);
		expect(isSuspiciousSetting('remote.origin.url', url)).toBe(false);
		expect(isSuspiciousSetting('core.alternaterefscommand', url)).toBe(true);
	});
});

describe('header precedence and error fields', () => {
	it('tolerates only an origin-scoped persisted header', () => {
		const url = 'https://github.com/acme/widgets.git';
		expect(isSuspiciousSetting('http.https://github.com/.extraheader', url)).toBe(false);
		expect(isSuspiciousSetting('http.https://github.com.extraheader', url)).toBe(false);
		expect(isSuspiciousSetting('http.https://github.com/acme/widgets.git.extraheader', url)).toBe(
			true,
		);
		expect(isSuspiciousSetting('http.extraheader', url)).toBe(true);
	});

	it('keeps no credential in a GitError, serialized or not', () => {
		const error = new GitError(
			['fetch', 'https://x-access-token:secret@github.com/a'],
			'fatal: https://x-access-token:secret@github.com/a',
			128,
		);
		expect(JSON.stringify(error)).not.toContain('secret');
		expect(error.args[1]).toBe('https://***@github.com/a');
		expect(error.stderr).toBe('fatal: https://***@github.com/a');
	});
});

describe('environment allowlist', () => {
	it('drops every inherited GIT_* variable', () => {
		const env = gitBaseEnv(
			{ GIT_EXEC_PATH: '/evil', GIT_SSH_COMMAND: 'evil', GIT_DIR: '/x', HOME: '/h' },
			{},
		);
		expect(env['GIT_EXEC_PATH']).toBeUndefined();
		expect(env['GIT_SSH_COMMAND']).toBeUndefined();
		expect(env['GIT_DIR']).toBeUndefined();
		expect(env['HOME']).toBe('/h');
	});

	it('flags the settings that make git run programs', () => {
		const url = 'https://github.com/acme/widgets.git';
		for (const name of [
			'core.sshcommand',
			'core.gitproxy',
			'credential.helper',
			'ssh.variant',
			'protocol.ext.allow',
			'url.x.insteadof',
			'remote.origin.uploadpack',
			'remote.origin.vcs',
		]) {
			expect(isSuspiciousSetting(name, url), name).toBe(true);
		}
		for (const name of [
			'core.filemode',
			'remote.origin.url',
			'remote.origin.fetch',
			'branch.main.remote',
		]) {
			expect(isSuspiciousSetting(name, url), name).toBe(false);
		}
	});
});

describe('plaintext and local transports', () => {
	it('never authenticates a plaintext http origin and recognizes relative paths', () => {
		expect(gitAuthConfig('http://ghe.test/acme/widgets', 'secret', 'http://ghe.test')).toEqual([]);
		expect(transportOf('../remote/acme/widgets.git')).toBe('file');
		expect(transportOf('./acme/widgets')).toBe('file');
		expect(
			remoteUrlServes('../remote/acme/widgets.git', 'acme/widgets', 'https://github.com'),
		).toBe(true);
	});

	it('scrubs the token and its encoded form', () => {
		const basic = Buffer.from('x-access-token:secret').toString('base64');
		expect(scrubSecrets(`token secret header ${basic} end`, 'secret')).toBe(
			'token *** header *** end',
		);
		expect(scrubSecrets('nothing', undefined)).toBe('nothing');
	});
});

describe('round 18 details', () => {
	it('scrubs a short token that occurs inside its own encoded form', () => {
		const basic = Buffer.from('x-access-token:e').toString('base64');
		expect(scrubSecrets(`a ${basic} b e c`, 'e')).toBe('a *** b *** c');
	});

	it('recognizes bare relative and Windows paths, and flags bundle URIs', () => {
		expect(transportOf('nested/acme/widgets')).toBe('file');
		expect(transportOf('C:\\repos\\widgets')).toBe('file');
		expect(transportOf('acme/widgets:x')).toBe('file');
		expect(isSuspiciousSetting('fetch.bundleuri', 'https://github.com/acme/widgets')).toBe(true);
		expect(isSuspiciousSetting('bundle.x.uri', 'https://github.com/acme/widgets')).toBe(true);
	});

	it('matches an http remote on the server host offline but not online', () => {
		expect(
			remoteUrlServes('http://github.com/acme/widgets', 'acme/widgets', 'https://github.com'),
		).toBe(false);
		expect(
			remoteUrlServes('http://github.com/acme/widgets', 'acme/widgets', 'https://github.com', {
				offline: true,
			}),
		).toBe(true);
	});
});

describe('round 19 details', () => {
	it('refuses option-looking remotes and matches Windows paths', () => {
		expect(
			remoteUrlServes('--upload-pack=/tmp/acme/widgets', 'acme/widgets', 'https://github.com'),
		).toBe(false);
		expect(remoteUrlServes('C:\\repos\\acme\\widgets', 'acme/widgets', 'https://github.com')).toBe(
			true,
		);
	});
});

describe('round 20 details', () => {
	it('drops GIT_* variables in any case and names UNC remotes as network transports', () => {
		const env = gitBaseEnv({ git_exec_path: '/evil', Git_Config_Global: '/g', PATH: '/bin' }, {});
		expect(env['git_exec_path']).toBeUndefined();
		expect(env['Git_Config_Global']).toBeUndefined();
		expect(env['PATH']).toBe('/bin');
		expect(transportOf('\\\\server\\share\\acme\\widgets')).toBe('unc');
		expect(transportOf('//server/share/acme/widgets')).toBe('unc');
		expect(transportOf('file://server/share/acme/widgets')).toBe('unc');
		expect(transportOf('file:///tmp/acme/widgets')).toBe('file');
	});
});

describe('round 21 details', () => {
	it('classifies every UNC file form as network transport', () => {
		expect(transportOf('file:////server/share/acme/widgets')).toBe('unc');
		expect(transportOf('file://///server/share/acme/widgets')).toBe('unc');
		expect(transportOf('file:\\\\\\\\server\\share\\acme\\widgets')).toBe('unc');
		expect(transportOf('file:///tmp/acme/widgets')).toBe('file');
		expect(transportOf('file:///C:/repos/acme/widgets')).toBe('file');
	});
});

describe('round 22 details', () => {
	it('sees through encoded backslashes and refuses query strings', () => {
		expect(transportOf('file:///%5Cserver/share/acme/widgets')).toBe('unc');
		expect(transportOf('file:///%5C%5Cserver/share/acme/widgets')).toBe('unc');
		expect(transportOf('file:///%E0%A4%A')).toBe('unc');
		expect(
			remoteUrlServes(
				'https://github.com/acme/widgets.git?token=x',
				'acme/widgets',
				'https://github.com',
			),
		).toBe(false);
		expect(
			remoteUrlServes(
				'https://github.com/acme/widgets.git#x',
				'acme/widgets',
				'https://github.com',
			),
		).toBe(false);
	});
});

describe('round 23 details', () => {
	it('refuses a bare ? or # in a remote URL', () => {
		expect(
			remoteUrlServes('https://github.com/acme/widgets.git?', 'acme/widgets', 'https://github.com'),
		).toBe(false);
		expect(
			remoteUrlServes('https://github.com/acme/widgets.git#', 'acme/widgets', 'https://github.com'),
		).toBe(false);
	});
});
