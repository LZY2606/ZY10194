/*
 * Copyright (c) Mike Lischke. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 */

/**
 * Structured, diagnostic-only candidate tracing for the CodeCompletionCore.
 *
 * The tracer is attached to the real ATN traversal in `collectCandidates`/`processRule` (it never simulates a
 * separate walk). All recorded data is stable across runs: only ATN state numbers, token types, rule indexes,
 * token list indexes and transition kinds are stored - never object identities or address dependent debug strings.
 */

/** The kind of an ATN transition, as recorded in trace steps. */
export type CandidateTraceTransitionKind =
    "atom" | "range" | "set" | "not-set" | "rule" | "epsilon" | "wildcard" | "predicate" | "precedence" | "action";

/** The condition which decided a candidate's fate. */
export type CandidateTraceReason =
    /** Collected from the (cached) follow set of a rule which starts at the caret. */
    | "follow-set"
    /** Collected from a labelled transition at the caret. */
    | "transition"
    /** Collected from a wildcard transition at the caret. */
    | "wildcard"
    /** A rule which was collected because it is in `preferredRules`. */
    | "preferred-rule"
    /** A token which was excluded because it is in `ignoredTokens`. */
    | "ignored-token";

/** Why a rule was not (re-)entered during the walk. */
export type CandidateTraceSkipReason =
    /** The rule was already processed with the same token position (shortcut map hit). */
    | "shortcut"
    /** The current input symbol is not in the rule's exhaustive follow set. */
    | "follow-set-miss";

/** A single ATN state visit during the traversal. */
export interface ICandidateTraceStepEvent {
    kind: "step";
    /** Index of the parent step event in the same event list, or -1 for root steps. */
    parent: number;
    stateNumber: number;
    /** Stable, human readable ATN state type name (e.g. "rule start", "block end"). */
    stateType: string;
    ruleIndex: number;
    /** Index into the filtered (default channel) token list. */
    tokenListIndex: number;
    /** The transition which led to this state (absent for root steps). */
    transitionKind?: CandidateTraceTransitionKind;
    /** Sorted token types of the transition label, if it has one. */
    transitionLabel?: number[];
    /** State number of the transition target. */
    transitionTarget?: number;
    /** Evaluation result for predicate and precedence transitions. */
    predicateResult?: boolean;
}

/** A decision which selected or excluded a concrete candidate. */
export interface ICandidateTraceDecisionEvent {
    kind: "decision";
    /** Index of the step event which provides the ATN path for this decision, or -1. */
    parent: number;
    candidateKind: "token" | "rule";
    tokenType?: number;
    ruleIndex?: number;
    status: "selected" | "excluded";
    reason: CandidateTraceReason;
    /** True when the candidate already existed and this decision merged into it. */
    merged: boolean;
    /** Rule call stack (rule indexes, outermost first) at the decision point. */
    callStack: number[];
}

/** A follow set cache lookup. */
export interface ICandidateTraceCacheEvent {
    kind: "follow-set-cache";
    hit: boolean;
    stateNumber: number;
    ruleIndex: number;
}

/** A rule which was not (re-)entered during the walk. */
export interface ICandidateTraceSkipEvent {
    kind: "rule-skipped";
    parent: number;
    reason: CandidateTraceSkipReason;
    ruleIndex: number;
    tokenListIndex: number;
}

export type CandidateTraceEvent =
    ICandidateTraceStepEvent | ICandidateTraceDecisionEvent | ICandidateTraceCacheEvent | ICandidateTraceSkipEvent;

/** One step of a witness path (a sanitized copy of a step event, root first). */
export interface ICandidateTraceStep {
    stateNumber: number;
    stateType: string;
    ruleIndex: number;
    tokenListIndex: number;
    transitionKind?: CandidateTraceTransitionKind;
    transitionLabel?: number[];
    transitionTarget?: number;
    predicateResult?: boolean;
}

/** The trace summary for a single candidate (a token type or a rule index). */
export interface ICandidateTrace {
    candidateKind: "token" | "rule";
    tokenType?: number;
    ruleIndex?: number;
    /** Status and reason of the first decisive condition recorded for this candidate. */
    status: "selected" | "excluded";
    reason: CandidateTraceReason;
    /** Rule call stack at the first decisive condition. */
    callStack: number[];
    /** Total number of traversal paths which reached a decision for this candidate. */
    pathCount: number;
    /** How many of these paths merged into an already collected candidate. */
    mergeCount: number;
    /**
     * Up to `maxWitnesses` shortest witness paths (each a list of steps, root first).
     * `pathCount` may be larger than the number of witnesses - a candidate reached via multiple paths is
     * never reported as unique.
     */
    witnesses: ICandidateTraceStep[][];
}

/** The outcome of a traced `collectCandidates` run. */
export interface ICandidateTraceResult {
    /**
     * Per-candidate summaries, sorted deterministically by candidate kind, token type/rule index and the
     * first witness path key. Never depends on set/map insertion order.
     */
    candidates: ICandidateTrace[];
    /** The bounded, chronological event log the summaries were built from. */
    events: readonly CandidateTraceEvent[];
    /** Follow set cache statistics for this run. */
    followSetCache: { hits: number; misses: number; };
    /** True when the event limit was reached. The collected candidate set is not affected by truncation. */
    truncated: boolean;
    /** Number of events which were dropped after the limit was reached. */
    droppedEvents: number;
}

/** Options controlling candidate tracing. */
export interface ICandidateTraceOptions {
    /** Maximum number of recorded events (default: 10000). Further events are dropped and counted. */
    maxEvents?: number;
    /** Maximum number of witness paths kept per candidate (default: 3). The shortest paths are kept. */
    maxWitnesses?: number;
}

interface IStepEventInput {
    parent: number;
    stateNumber: number;
    stateType: string;
    ruleIndex: number;
    tokenListIndex: number;
    transitionKind?: CandidateTraceTransitionKind;
    transitionLabel?: number[];
    transitionTarget?: number;
    predicateResult?: boolean;
}

interface IDecisionEventInput {
    candidateKind: "token" | "rule";
    tokenType?: number;
    ruleIndex?: number;
    status: "selected" | "excluded";
    reason: CandidateTraceReason;
    merged: boolean;
    callStack: number[];
}

interface IPathEntry {
    key: string;
    steps: ICandidateTraceStep[];
}

/**
 * Records trace events during a single `collectCandidates` run. All methods are no-throw and allocation free
 * once the event limit was reached, so tracing can never change the collected candidate set.
 */
export class CandidateTracer {

    /**
     * The index of the step event which describes the current traversal position. Decisions and skip events
     * recorded without an explicit parent attach to this step. Maintained by the core while it walks the ATN.
     */
    public currentStep = -1;

    private readonly maxEvents: number;
    private readonly maxWitnesses: number;

    private events: CandidateTraceEvent[] = [];
    private truncated = false;
    private droppedEvents = 0;
    private cacheHits = 0;
    private cacheMisses = 0;

    public constructor(options?: ICandidateTraceOptions) {
        this.maxEvents = options?.maxEvents ?? 10000;
        this.maxWitnesses = options?.maxWitnesses ?? 3;
    }

    private static pathKey(steps: ICandidateTraceStep[]): string {
        return steps.map((step) => {
            return `${step.stateNumber}${step.transitionKind ? `:${step.transitionKind}` : ""}`;
        }).join(">");
    }

    /**
     * Records an ATN state visit.
     *
     * @param step The step data.
     * @returns The index of the new event (to be used as parent for follow-up events) or -1 when truncated.
     */
    public recordStep(step: IStepEventInput): number {
        if (!this.canRecord()) {
            return -1;
        }

        this.events.push({ kind: "step", ...step });

        return this.events.length - 1;
    }

    /**
     * Records a candidate decision at the current step.
     *
     * @param decision The decision data.
     */
    public recordDecision(decision: IDecisionEventInput): void {
        if (!this.canRecord()) {
            return;
        }

        this.events.push({ kind: "decision", parent: this.currentStep, ...decision });
    }

    /**
     * Records a follow set cache lookup. Counters are kept even when the event log is truncated.
     *
     * @param hit True when the follow sets for the state were already cached.
     * @param stateNumber The rule start state number the follow sets belong to.
     * @param ruleIndex The rule the follow sets belong to.
     */
    public recordCacheEvent(hit: boolean, stateNumber: number, ruleIndex: number): void {
        if (hit) {
            ++this.cacheHits;
        } else {
            ++this.cacheMisses;
        }

        if (!this.canRecord()) {
            return;
        }

        this.events.push({ kind: "follow-set-cache", hit, stateNumber, ruleIndex });
    }

    /**
     * Records a rule which was not (re-)entered.
     *
     * @param reason Why the rule was skipped.
     * @param ruleIndex The index of the skipped rule.
     * @param tokenListIndex The token position at which the rule was skipped.
     */
    public recordSkip(reason: CandidateTraceSkipReason, ruleIndex: number, tokenListIndex: number): void {
        if (!this.canRecord()) {
            return;
        }

        this.events.push({
            kind: "rule-skipped",
            parent: this.currentStep,
            reason,
            ruleIndex,
            tokenListIndex,
        });
    }

    /**
     * Builds the final trace result. Called once by the core after the traversal finished.
     *
     * @returns The structured trace.
     */
    public finish(): ICandidateTraceResult {
        const groups = new Map<string, {
            first: ICandidateTraceDecisionEvent;
            pathCount: number;
            mergeCount: number;
            paths: IPathEntry[];
        }>();

        for (const event of this.events) {
            if (event.kind !== "decision") {
                continue;
            }

            const key = event.candidateKind === "token" ? `t:${event.tokenType}` : `r:${event.ruleIndex}`;
            let group = groups.get(key);
            if (!group) {
                group = { first: event, pathCount: 0, mergeCount: 0, paths: [] };
                groups.set(key, group);
            }

            ++group.pathCount;
            if (event.merged) {
                ++group.mergeCount;
            }

            const steps = this.buildPath(event.parent);
            group.paths.push({ key: CandidateTracer.pathKey(steps), steps });
        }

        const candidates: ICandidateTrace[] = [];
        for (const group of groups.values()) {
            // Keep only the shortest witness paths, with a stable tie break on the path key.
            group.paths.sort((a, b) => {
                return a.steps.length - b.steps.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
            });

            const { first } = group;
            candidates.push({
                candidateKind: first.candidateKind,
                tokenType: first.tokenType,
                ruleIndex: first.ruleIndex,
                status: first.status,
                reason: first.reason,
                callStack: first.callStack,
                pathCount: group.pathCount,
                mergeCount: group.mergeCount,
                witnesses: group.paths.slice(0, this.maxWitnesses).map((path) => {
                    return path.steps;
                }),
            });
        }

        // Deterministic order: candidate kind, then token type/rule index, then the first witness path key.
        candidates.sort((a, b) => {
            if (a.candidateKind !== b.candidateKind) {
                return a.candidateKind < b.candidateKind ? -1 : 1;
            }

            const idA = a.candidateKind === "token" ? a.tokenType! : a.ruleIndex!;
            const idB = b.candidateKind === "token" ? b.tokenType! : b.ruleIndex!;
            if (idA !== idB) {
                return idA - idB;
            }

            const keyA = a.witnesses.length > 0 ? CandidateTracer.pathKey(a.witnesses[0]) : "";
            const keyB = b.witnesses.length > 0 ? CandidateTracer.pathKey(b.witnesses[0]) : "";

            return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
        });

        return {
            candidates,
            events: this.events,
            followSetCache: { hits: this.cacheHits, misses: this.cacheMisses },
            truncated: this.truncated,
            droppedEvents: this.droppedEvents,
        };
    }

    private canRecord(): boolean {
        if (this.truncated) {
            ++this.droppedEvents;

            return false;
        }

        if (this.events.length >= this.maxEvents) {
            this.truncated = true;
            ++this.droppedEvents;

            return false;
        }

        return true;
    }

    /**
     * Reconstructs the step chain (root first) which leads to the given event index.
     *
     * @param parent The event index to start from.
     * @returns The witness path steps, root first.
     */
    private buildPath(parent: number): ICandidateTraceStep[] {
        const steps: ICandidateTraceStep[] = [];
        let index = parent;
        while (index >= 0) {
            const event = this.events[index];
            if (event.kind !== "step") {
                break;
            }

            steps.push({
                stateNumber: event.stateNumber,
                stateType: event.stateType,
                ruleIndex: event.ruleIndex,
                tokenListIndex: event.tokenListIndex,
                transitionKind: event.transitionKind,
                transitionLabel: event.transitionLabel,
                transitionTarget: event.transitionTarget,
                predicateResult: event.predicateResult,
            });
            index = event.parent;
        }

        steps.reverse();

        return steps;
    }
}
