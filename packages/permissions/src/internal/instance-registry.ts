/**
 * Process-wide claim on an explicit `engine.instanceId`.
 *
 * Two engines sharing an instance id share every WASM policy-set id derived from
 * it, so the second registration silently overwrites the first one's preparsed
 * sets — which surfaces later as a scope answering with another tenant's
 * policies. Generated ids are random and cannot collide, so only explicit ones
 * are tracked.
 *
 * The claim is released on application shutdown, which is what keeps a test
 * suite (or a re-created Nest app) free to reuse the same explicit id
 * sequentially.
 */
const claimed = new Set<string>();

/** @throws `Error` when `instanceId` is already claimed by a live engine. */
export function claimInstanceId(instanceId: string): void {
	if (claimed.has(instanceId)) {
		throw new Error(
			`PermissionsModule: engine.instanceId "${instanceId}" is already in use by another live ` +
				"module registration. Two engines sharing an instance id overwrite each other's " +
				"preparsed policy sets; omit the option for a generated id.",
		);
	}
	claimed.add(instanceId);
}

/** Releases a claim. Unknown ids are ignored. */
export function releaseInstanceId(instanceId: string): void {
	claimed.delete(instanceId);
}

/** Whether `instanceId` is currently claimed. Test seam. */
export function isInstanceIdClaimed(instanceId: string): boolean {
	return claimed.has(instanceId);
}
