import { snapshotStatus } from '$lib/server/state';

export function load() {
	return {
		status: snapshotStatus()
	};
}
