/*
 * This file is released under the MIT license.
 * Copyright (c) 2026 Mike Lischke
 *
 * See LICENSE file for more info.
 */

// cspell: disable

import { CharStream, CommonTokenStream } from "antlr4ng";
import { describe, expect, it } from "vitest";

import { CPP14Lexer } from "./generated/CPP14Lexer";
import { CPP14Parser } from "./generated/CPP14Parser";
import { ExprLexer } from "./generated/ExprLexer";
import { ExprParser } from "./generated/ExprParser";
import { WhiteboxLexer } from "./generated/WhiteboxLexer";
import { WhiteboxParser } from "./generated/WhiteboxParser";

import { CandidatesCollection, CodeCompletionCore } from "../src/CodeCompletionCore";
import { CandidateTraceEvent, ICandidateTraceResult } from "../src/CandidateTracing";

/**
 * Normalizes a candidate collection to a comparable, order independent structure.
 *
 * @param candidates The candidates to normalize.
 * @returns A plain, sorted representation of the candidates.
 */
const normalizeCandidates = (candidates: CandidatesCollection): unknown => {
    return {
        tokens: [...candidates.tokens.entries()].sort((a, b) => {
            return a[0] - b[0];
        }),
        rules: [...candidates.rules.entries()].sort((a, b) => {
            return a[0] - b[0];
        }),
    };
};

const stepEvents = (trace: ICandidateTraceResult): CandidateTraceEvent[] => {
    return trace.events.filter((event) => {
        return event.kind === "step";
    });
};

describe("Candidate Tracing", () => {
    describe("Expr grammar:", () => {
        const createCore = (input: string, configure: boolean): CodeCompletionCore => {
            const lexer = new ExprLexer(CharStream.fromString(input));
            const parser = new ExprParser(new CommonTokenStream(lexer));
            parser.removeErrorListeners();
            parser.expression();

            const core = new CodeCompletionCore(parser);
            if (configure) {
                core.ignoredTokens = new Set([
                    ExprLexer.ID, ExprLexer.PLUS, ExprLexer.MINUS, ExprLexer.MULTIPLY, ExprLexer.DIVIDE,
                    ExprLexer.EQUAL,
                ]);
                core.preferredRules = new Set([ExprParser.RULE_functionRef, ExprParser.RULE_variableRef]);
            }

            return core;
        };

        it("Trace is only available when enabled", () => {
            const core = createCore("var c = a + b()", true);
            core.collectCandidates(0);
            expect(core.candidateTrace, "no trace expected when tracing is disabled").toBeUndefined();

            core.candidateTraceOptions = {};
            core.collectCandidates(0);
            expect(core.candidateTrace, "trace expected after enabling tracing").toBeDefined();
        });

        it("Tracing does not change the collected candidates", () => {
            // Covers caret positions at the input start, on and around hidden (WS) tokens and at EOF.
            for (const caret of [0, 1, 2, 4, 6, 8, 10, 13]) {
                const untraced = createCore("var c = a + b()", true).collectCandidates(caret);

                const core = createCore("var c = a + b()", true);
                core.candidateTraceOptions = {};
                const traced = core.collectCandidates(caret);

                expect(normalizeCandidates(traced), `candidates differ with tracing at caret ${caret}`)
                    .toEqual(normalizeCandidates(untraced));
            }
        });

        it("Token candidates from follow sets and ignored tokens at the input start", () => {
            // No preferred rules here, so the ID token is evaluated (and ignored) as a token candidate.
            const core = createCore("var c = a + b()", false);
            core.ignoredTokens = new Set([ExprLexer.ID]);
            core.candidateTraceOptions = {};
            const candidates = core.collectCandidates(0);

            expect(candidates.tokens.has(ExprLexer.VAR), "VAR must be collected").toEqual(true);
            expect(candidates.tokens.has(ExprLexer.ID), "ID must not be collected").toEqual(false);

            const trace = core.candidateTrace!;
            const varCandidate = trace.candidates.find((candidate) => {
                return candidate.tokenType === ExprLexer.VAR;
            });
            expect(varCandidate?.status, "VAR must be selected").toEqual("selected");
            expect(varCandidate?.reason, "VAR comes from a rule start follow set").toEqual("follow-set");
            expect(varCandidate?.pathCount, "VAR must have at least one path").toBeGreaterThanOrEqual(1);
            expect(varCandidate?.witnesses.length, "VAR must have a witness path").toBeGreaterThanOrEqual(1);

            const idCandidate = trace.candidates.find((candidate) => {
                return candidate.tokenType === ExprLexer.ID;
            });
            expect(idCandidate?.status, "ID is in ignoredTokens").toEqual("excluded");
            expect(idCandidate?.reason, "ID must be excluded via the ignored token list").toEqual("ignored-token");
        });

        it("Preferred rule candidates carry their rule stack", () => {
            const core = createCore("var c = a + b()", true);
            core.candidateTraceOptions = {};
            const candidates = core.collectCandidates(6);

            const trace = core.candidateTrace!;
            const functionRef = trace.candidates.find((candidate) => {
                return candidate.ruleIndex === ExprParser.RULE_functionRef;
            });
            expect(functionRef?.status, "functionRef must be selected").toEqual("selected");
            expect(functionRef?.reason, "functionRef is a preferred rule").toEqual("preferred-rule");
            expect(functionRef?.callStack[0], "the call stack starts with the start rule")
                .toEqual(ExprParser.RULE_expression);
            expect(functionRef?.callStack, "trace call stack matches the collected rule list")
                .toEqual(candidates.rules.get(ExprParser.RULE_functionRef)?.ruleList);
        });

        it("Left recursive rules record precedence transitions", () => {
            const lexer = new ExprLexer(CharStream.fromString("var c = a + b"));
            const parser = new ExprParser(new CommonTokenStream(lexer));
            parser.removeErrorListeners();
            parser.expression();

            const core = new CodeCompletionCore(parser);
            core.preferredRules = new Set([ExprParser.RULE_simpleExpression]);
            core.candidateTraceOptions = {};
            const candidates = core.collectCandidates(10);

            const trace = core.candidateTrace!;
            const precedenceSteps = stepEvents(trace).filter((event) => {
                return event.kind === "step" && event.transitionKind === "precedence";
            });
            expect(precedenceSteps.length, "left recursion must produce precedence steps").toBeGreaterThan(0);
            for (const step of precedenceSteps) {
                expect(typeof (step as { predicateResult?: boolean; }).predicateResult,
                    "precedence steps record their evaluation result").toBe("boolean");
            }

            const rule = trace.candidates.find((candidate) => {
                return candidate.candidateKind === "rule";
            });
            expect(rule?.ruleIndex, "simpleExpression must be traced").toEqual(ExprParser.RULE_simpleExpression);
            expect(rule?.reason, "simpleExpression is a preferred rule").toEqual("preferred-rule");
            expect(candidates.rules.has(ExprParser.RULE_simpleExpression),
                "simpleExpression must be collected").toEqual(true);
        });
    });

    describe("Whitebox grammar:", () => {
        const createCore = (input: string, rule: "test1" | "test9" | "test10", rejectIpsum = true) => {
            const lexer = new WhiteboxLexer(CharStream.fromString(input));
            const parser = new WhiteboxParser(new CommonTokenStream(lexer));
            parser.removeErrorListeners();
            parser.rejectIpsum = rejectIpsum;
            const context = parser[rule]();

            return { core: new CodeCompletionCore(parser), context };
        };

        it("Epsilon transitions and caret at EOF", () => {
            const { core, context } = createCore("LOREM ", "test1");
            core.candidateTraceOptions = {};
            const candidates = core.collectCandidates(1, context); // caret on EOF

            expect(candidates.tokens.size, "epsilon grammar still collects all 5 tokens").toEqual(5);

            const trace = core.candidateTrace!;
            const epsilonSteps = stepEvents(trace).filter((event) => {
                return event.kind === "step" && event.transitionKind === "epsilon";
            });
            expect(epsilonSteps.length, "empty rules must be traversed via epsilon steps").toBeGreaterThan(0);

            const followSetCandidates = trace.candidates.filter((candidate) => {
                return candidate.reason === "follow-set";
            });
            expect(followSetCandidates.length, "candidates at EOF come from follow sets").toBeGreaterThan(0);

            for (const event of stepEvents(trace)) {
                if (event.kind === "step") {
                    expect(Number.isInteger(event.stateNumber), "state numbers must be stable integers").toBe(true);
                    expect(Number.isInteger(event.tokenListIndex), "token indexes must be stable integers")
                        .toBe(true);
                }
            }
        });

        it("Wildcard transitions at and before the caret", () => {
            // Caret directly at the wildcard: every user token except the ignored WS token is a candidate.
            const { core, context } = createCore("LOREM ", "test9");
            core.ignoredTokens = new Set([WhiteboxLexer.WS]);
            core.candidateTraceOptions = {};
            const candidates = core.collectCandidates(1, context);

            expect(candidates.tokens.size, "wildcard suggests all non-ignored user tokens").toEqual(7);
            const trace = core.candidateTrace!;
            const wildcardCandidates = trace.candidates.filter((candidate) => {
                return candidate.reason === "wildcard";
            });
            expect(wildcardCandidates.length, "7 tokens selected via the wildcard transition").toEqual(7);

            const wsCandidate = trace.candidates.find((candidate) => {
                return candidate.tokenType === WhiteboxLexer.WS;
            });
            expect(wsCandidate?.status, "WS is ignored").toEqual("excluded");
            expect(wsCandidate?.reason, "WS is excluded via the ignored token list").toEqual("ignored-token");

            // Caret after the wildcard: the wildcard consumes IPSUM and CONSECTETUR remains.
            const consumed = createCore("LOREM IPSUM ", "test9");
            consumed.core.candidateTraceOptions = {};
            const consumedCandidates = consumed.core.collectCandidates(2, consumed.context);
            expect(consumedCandidates.tokens.has(WhiteboxLexer.CONSECTETUR),
                "only CONSECTETUR can follow the wildcard").toEqual(true);

            const wildcardSteps = stepEvents(consumed.core.candidateTrace!).filter((event) => {
                return event.kind === "step" && event.transitionKind === "wildcard";
            });
            expect(wildcardSteps.length, "the consuming wildcard transition must be traced").toEqual(1);
        });

        it("Predicate transitions record their evaluation result", () => {
            const accepted = createCore("LOREM ", "test10", true);
            accepted.core.candidateTraceOptions = {};
            const acceptedCandidates = accepted.core.collectCandidates(1, accepted.context);
            expect([...acceptedCandidates.tokens.keys()], "only IPSUM passes the predicates")
                .toEqual([WhiteboxLexer.IPSUM]);

            const acceptedTrace = accepted.core.candidateTrace!;
            const predicateResults = stepEvents(acceptedTrace).filter((event) => {
                return event.kind === "step" && event.transitionKind === "predicate";
            }).map((event) => {
                return (event as { predicateResult?: boolean; }).predicateResult;
            });
            expect(predicateResults, "both predicate evaluations must be traced")
                .toEqual(expect.arrayContaining([true, false]));

            const rejected = createCore("LOREM ", "test10", false);
            rejected.core.candidateTraceOptions = {};
            const rejectedCandidates = rejected.core.collectCandidates(1, rejected.context);
            expect([...rejectedCandidates.tokens.keys()], "flipping the predicate selects DOLOR instead")
                .toEqual([WhiteboxLexer.DOLOR]);
        });
    });

    describe("CPP14 grammar:", () => {
        const createCore = (): CodeCompletionCore => {
            const inputStream = CharStream.fromString("class A {\n" +
                "public:\n" +
                "  void test() {\n" +
                "  }\n};\n",
            );
            const parser = new CPP14Parser(new CommonTokenStream(new CPP14Lexer(inputStream)));
            parser.removeErrorListeners();
            parser.translationunit();

            const core = new CodeCompletionCore(parser);
            core.ignoredTokens = new Set([
                CPP14Lexer.Identifier,
                CPP14Lexer.LeftParen, CPP14Lexer.RightParen,
                CPP14Lexer.Operator, CPP14Lexer.Star, CPP14Lexer.And, CPP14Lexer.AndAnd,
                CPP14Lexer.LeftBracket,
                CPP14Lexer.Ellipsis,
                CPP14Lexer.Doublecolon, CPP14Lexer.Semi,
            ]);
            core.preferredRules = new Set([
                CPP14Parser.RULE_classname, CPP14Parser.RULE_namespacename, CPP14Parser.RULE_idexpression,
            ]);

            return core;
        };

        it("Records cache events, rule skips and multi-path candidates", () => {
            const untraced = createCore().collectCandidates(10);

            const core = createCore();
            core.candidateTraceOptions = {};
            const traced = core.collectCandidates(10);
            expect(normalizeCandidates(traced), "tracing must not change the candidates")
                .toEqual(normalizeCandidates(untraced));

            const trace = core.candidateTrace!;
            expect(trace.followSetCache.hits + trace.followSetCache.misses,
                "follow set cache lookups must be counted").toBeGreaterThan(0);

            const shortcutSkips = trace.events.filter((event) => {
                return event.kind === "rule-skipped" && event.reason === "shortcut";
            });
            expect(shortcutSkips.length, "recursive rules must terminate via the shortcut map").toBeGreaterThan(0);

            const followSetMisses = trace.events.filter((event) => {
                return event.kind === "rule-skipped" && event.reason === "follow-set-miss";
            });
            expect(followSetMisses.length, "rules with non-matching follow sets must be traced")
                .toBeGreaterThan(0);

            // Candidates reached via multiple paths keep a bounded number of shortest witnesses, but the
            // total path count must reflect every path (no fake uniqueness through deduplication).
            const multiPath = trace.candidates.filter((candidate) => {
                return candidate.pathCount > 1;
            });
            expect(multiPath.length, "many candidates are reachable via multiple paths").toBeGreaterThan(0);
            for (const candidate of trace.candidates) {
                expect(candidate.witnesses.length, "witnesses are bounded by maxWitnesses (default 3)")
                    .toBeLessThanOrEqual(3);
                expect(candidate.pathCount, "path count includes all merged paths")
                    .toBeGreaterThanOrEqual(candidate.witnesses.length);
            }
            const withMorePathsThanWitnesses = multiPath.filter((candidate) => {
                return candidate.pathCount > candidate.witnesses.length;
            });
            expect(withMorePathsThanWitnesses.length,
                "at least one candidate must have more paths than kept witnesses").toBeGreaterThan(0);

            const classname = trace.candidates.find((candidate) => {
                return candidate.ruleIndex === CPP14Parser.RULE_classname;
            });
            expect(classname?.reason, "classname is a preferred rule").toEqual("preferred-rule");
            expect(classname?.callStack[0], "the call stack starts with the start rule")
                .toEqual(CPP14Parser.RULE_translationunit);

            // The candidates map keeps the last path per rule, while the trace records every path.
            // The path stored in the candidates must therefore appear among the traced decisions.
            const collectedPath = JSON.stringify(traced.rules.get(CPP14Parser.RULE_classname)?.ruleList);
            const matchingDecisions = trace.events.filter((event) => {
                return event.kind === "decision" && event.ruleIndex === CPP14Parser.RULE_classname
                    && JSON.stringify(event.callStack) === collectedPath;
            });
            expect(matchingDecisions.length, "the collected rule path must be traced").toBeGreaterThan(0);

            const identifier = trace.candidates.find((candidate) => {
                return candidate.tokenType === CPP14Lexer.Identifier;
            });
            expect(identifier?.status, "Identifier is ignored").toEqual("excluded");
            expect(identifier?.reason, "Identifier is excluded via the ignored token list")
                .toEqual("ignored-token");
        });

        it("Produces deterministic, stably sorted traces", () => {
            const collect = (): ICandidateTraceResult => {
                const core = createCore();
                core.candidateTraceOptions = {};
                core.collectCandidates(10);

                return core.candidateTrace!;
            };

            const first = collect();
            const second = collect();
            expect(JSON.stringify(second.candidates), "two runs must produce identical candidate traces")
                .toEqual(JSON.stringify(first.candidates));

            // Candidates must be sorted by candidate kind, then token type/rule index, then path key.
            for (let i = 1; i < first.candidates.length; i++) {
                const previous = first.candidates[i - 1];
                const current = first.candidates[i];
                if (previous.candidateKind !== current.candidateKind) {
                    expect(previous.candidateKind < current.candidateKind,
                        "candidates are grouped by kind").toEqual(true);
                } else {
                    const previousId = previous.candidateKind === "token"
                        ? previous.tokenType!
                        : previous.ruleIndex!;
                    const currentId = current.candidateKind === "token"
                        ? current.tokenType!
                        : current.ruleIndex!;
                    expect(previousId <= currentId,
                        "candidates are ordered by token type/rule index").toEqual(true);
                }
            }

            // No object addresses or debug strings anywhere in the trace: everything must be JSON data.
            expect(() => {
                JSON.stringify(first);
            }, "the trace must be serializable").not.toThrow();
        });

        it("Truncates the event log without changing the candidates", () => {
            const reference = createCore();
            reference.candidateTraceOptions = {};
            const referenceCandidates = reference.collectCandidates(10);
            expect(reference.candidateTrace!.truncated, "the reference run must not be truncated").toEqual(false);

            const core = createCore();
            core.candidateTraceOptions = { maxEvents: 50 };
            const candidates = core.collectCandidates(10);

            const trace = core.candidateTrace!;
            expect(trace.truncated, "the event limit must be reported").toEqual(true);
            expect(trace.events.length, "the event log is bounded").toBeLessThanOrEqual(50);
            expect(trace.droppedEvents, "dropped events are counted").toBeGreaterThan(0);
            expect(normalizeCandidates(candidates), "truncation must not change the candidates")
                .toEqual(normalizeCandidates(referenceCandidates));
        });

        it("Bounds the number of witnesses per candidate", () => {
            const core = createCore();
            core.candidateTraceOptions = { maxWitnesses: 1 };
            core.collectCandidates(10);

            const trace = core.candidateTrace!;
            for (const candidate of trace.candidates) {
                expect(candidate.witnesses.length, "at most one witness per candidate").toBeLessThanOrEqual(1);
            }
            const multiPath = trace.candidates.filter((candidate) => {
                return candidate.pathCount > 1;
            });
            expect(multiPath.length, "path counts are still complete with a single kept witness")
                .toBeGreaterThan(0);
        });
    });
});
