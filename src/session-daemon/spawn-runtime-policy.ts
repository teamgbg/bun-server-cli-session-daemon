/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Fleet eligibility policy at the fleet-only spawn route. Eligibility is a
 * field on the executable picker row itself, so menu, argv, model, provider,
 * and fleet availability cannot disagree across catalogues.
 */

export interface FleetSpawnOption {
	/** The session_picker_option slug, quoted back in a refusal. */
	slug: string;
	config: {
		fleet_enabled?: boolean;
		unavailable_reason?: string;
	};
}

export type FleetSpawnVerdict = { ok: true } | { ok: false; error: string };

/**
 * May the fleet spawn this exact option? A missing or false field refuses;
 * operator picker launches use a different route and remain unaffected.
 */
export function assertFleetSpawnable(
	option: FleetSpawnOption,
	options: FleetSpawnOption[],
): FleetSpawnVerdict {
	if (option.config.fleet_enabled === true) return { ok: true };
	const reason = option.config.unavailable_reason
		? ` ${option.config.unavailable_reason}`
		: "";
	const usable = options
		.filter((candidate) => candidate.config.fleet_enabled === true)
		.map((candidate) => candidate.slug)
		.join(", ");
	return {
		ok: false,
		error:
			`"${option.slug}" is a real picker option but is not fleet-enabled, so the fleet may not spawn it.${reason} ` +
			`Fleet-spawnable options: ${usable || "none"}. ` +
			`The operator may still open any CLI by hand via the picker — this binds only fleet spawning. ` +
			`To change what the fleet may spawn, update this picker option; do not work around this by calling an operator route.`,
	};
}
