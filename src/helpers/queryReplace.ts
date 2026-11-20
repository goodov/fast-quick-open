/** A single configured `fastQuickOpen.queryReplace` rewrite rule. */
export interface QueryReplaceRule {
  find: string;
  replace?: string;
  flags?: string;
}

export interface CompiledQueryReplaceRule {
  regex: RegExp;
  replace: string;
}

interface CompiledQueryReplaceGroup {
  /** When set, the leading rule also gates whether the group runs at all. */
  gated: boolean;
  rules: CompiledQueryReplaceRule[];
}

export interface CompiledQueryReplaceRules {
  replacer: QueryReplacer;
  errors: string[];
}

/** Cap on intermediate results so an expanding `g` rule cannot run away. */
const MAX_QUERY_LENGTH = 1024;

const VALID_FLAGS = /^[dgimsuvy]*$/;

function matches(rule: CompiledQueryReplaceRule, query: string): boolean {
  rule.regex.lastIndex = 0;
  return rule.regex.test(query);
}

function runRules(
  query: string,
  rules: readonly CompiledQueryReplaceRule[],
): string {
  let result = query;
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    const next = result.replace(rule.regex, rule.replace);
    if (next.length > MAX_QUERY_LENGTH) {
      return result;
    }
    result = next;
  }
  return result;
}

/**
 * Applies rules in declaration order. The first gated group whose leading rule
 * matches wins; later unconditional rules still run, but later groups do not.
 */
export class QueryReplacer {
  constructor(private readonly groups: readonly CompiledQueryReplaceGroup[]) {}

  apply(query: string): string {
    let result = query;
    let groupMatched = false;
    for (const group of this.groups) {
      const gate = group.rules[0];
      if (!gate) {
        continue;
      }
      if (!group.gated) {
        result = runRules(result, group.rules);
        continue;
      }
      if (!groupMatched && matches(gate, result)) {
        result = runRules(result, group.rules);
        groupMatched = true;
      }
    }
    return result;
  }
}

function compileRule(
  entry: unknown,
  at: string,
  errors: string[],
): CompiledQueryReplaceRule | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(`${at}: not an object`);
    return undefined;
  }

  const { find, replace, flags } = entry as Record<string, unknown>;
  if (typeof find !== 'string' || find.length === 0) {
    errors.push(`${at}: "find" must be a non-empty string`);
    return undefined;
  }
  if (replace !== undefined && typeof replace !== 'string') {
    errors.push(`${at}: "replace" must be a string`);
    return undefined;
  }
  if (
    flags !== undefined
    && (typeof flags !== 'string' || !VALID_FLAGS.test(flags))
  ) {
    errors.push(`${at}: invalid "flags"`);
    return undefined;
  }

  try {
    return { regex: new RegExp(find, flags ?? ''), replace: replace ?? '' };
  } catch (error) {
    errors.push(`${at}: ${(error as Error).message}`);
    return undefined;
  }
}

export function compileQueryReplaceRules(
  input: unknown,
): CompiledQueryReplaceRules {
  const groups: CompiledQueryReplaceGroup[] = [];
  const errors: string[] = [];
  const done = () => ({ replacer: new QueryReplacer(groups), errors });

  if (input === undefined || input === null) {
    return done();
  }
  if (!Array.isArray(input)) {
    errors.push('must be an array of rules or an array of rule groups');
    return done();
  }
  if (input.length === 0) {
    return done();
  }

  input.forEach((entry, index) => {
    if (Array.isArray(entry)) {
      const rules = entry
        .map((rule, ruleIndex) =>
          compileRule(rule, `group ${index} rule ${ruleIndex}`, errors),
        )
        .filter((rule) => rule !== undefined);
      if (rules.length > 0) {
        groups.push({ gated: true, rules });
      }
      return;
    }

    const rule = compileRule(entry, `rule ${index}`, errors);
    if (rule) {
      groups.push({ gated: false, rules: [rule] });
    }
  });

  return done();
}
