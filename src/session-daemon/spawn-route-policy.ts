/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Select spawn authority from the authenticated route, never from catalogue
 * availability or a caller-chosen header. The operator and fleet routes share
 * spawn mechanics but cannot share policy.
 */

export type SpawnRouteKind = "operator" | "fleet";

export type SpawnRouteVerdict =
	| {
			ok: true;
			requestedBy: string;
			enforceRuntimePolicy: boolean;
	  }
	| { ok: false; status: 400 | 403; error: string };

export interface SpawnRouteHeaders {
	operatorToken?: string;
	requestedBy?: string;
	lanePane?: string;
}

/**
 * Authenticate one of the two spawn entry routes and return its immutable
 * policy. A token proves access to the operator route; it never toggles fleet
 * policy on a shared route. Fleet attribution proves access to the fleet route;
 * it can never grant operator policy.
 */
export function resolveSpawnRoutePolicy(
	kind: SpawnRouteKind,
	headers: SpawnRouteHeaders,
	expectedOperatorToken: string | null,
): SpawnRouteVerdict {
	if (kind === "operator") {
		if (!expectedOperatorToken || headers.operatorToken !== expectedOperatorToken) {
			return {
				ok: false,
				status: 403,
				error: "operator picker authentication failed; refresh the picker against the current session-picker process",
			};
		}
		const requestedBy = headers.lanePane ?? headers.requestedBy;
		if (!requestedBy) {
			return {
				ok: false,
				status: 400,
				error: "operator spawn requires x-lane-pane or x-requested-by attribution",
			};
		}
		return {
			ok: true,
			requestedBy,
			enforceRuntimePolicy: false,
		};
	}

	if (!headers.requestedBy) {
		return {
			ok: false,
			status: 400,
			error: "fleet spawn requires x-requested-by attribution from the gateway",
		};
	}
	return {
		ok: true,
		requestedBy: headers.requestedBy,
		enforceRuntimePolicy: true,
	};
}
