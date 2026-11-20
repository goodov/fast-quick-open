import * as vscode from 'vscode';
import { isOnDemandLastTerm } from '../onDemand.ts';

// From VS Code extractRangeFromFilter (workbench/contrib/search/common/search.ts).
const LINE_COLON_PATTERN =
  /\s?[#:(](?:line )?(\d*)(?:[#:,](\d*))?(?:-(\d*)(?:[#:,](\d*))?)?\)?:?\s*$/;

export interface QueryRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface FilterAndRange {
  filter: string;
  range: QueryRange;
}

function isNumber(value: number): boolean {
  return Number.isFinite(value);
}

function rangeFromMatch(patternMatch: RegExpExecArray): QueryRange | undefined {
  const startLineNumber = parseInt(patternMatch[1] ?? '', 10);

  if (isNumber(startLineNumber)) {
    let range: QueryRange = {
      startLine: startLineNumber,
      startColumn: 1,
      endLine: startLineNumber,
      endColumn: 1,
    };

    const startColumn = parseInt(patternMatch[2] ?? '', 10);
    if (isNumber(startColumn)) {
      range = {
        startLine: range.startLine,
        startColumn,
        endLine: range.endLine,
        endColumn: startColumn,
      };
    }

    const endLineNumber = parseInt(patternMatch[3] ?? '', 10);
    if (isNumber(endLineNumber)) {
      const endColumn = parseInt(patternMatch[4] ?? '', 10);
      range = {
        startLine: range.startLine,
        startColumn: range.startColumn,
        endLine: endLineNumber,
        endColumn: isNumber(endColumn) ? endColumn : 1,
      };
    }

    return range;
  }

  if (patternMatch[1] === '') {
    return {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    };
  }

  return undefined;
}

function extractRangeAtEnd(value: string): FilterAndRange | undefined {
  const patternMatch = LINE_COLON_PATTERN.exec(value);
  if (!patternMatch) {
    return undefined;
  }
  const range = rangeFromMatch(patternMatch);
  if (!range) {
    return undefined;
  }
  return {
    filter: value.slice(0, patternMatch.index),
    range,
  };
}

/**
 * `{ filter, range }` when the value ends with a line/column suffix, or when
 * that suffix sits immediately before a last-term on-demand scope key.
 */
export function extractRangeFromFilter(
  value: string,
): FilterAndRange | undefined {
  const atEnd = extractRangeAtEnd(value);
  if (atEnd) {
    return atEnd;
  }

  const lastSpace = value.lastIndexOf(' ');
  if (lastSpace < 0) {
    return undefined;
  }

  const prefix = value.slice(0, lastSpace);
  const last = value.slice(lastSpace + 1);
  if (!prefix || !last || !isOnDemandLastTerm(last)) {
    return undefined;
  }

  const fromPrefix = extractRangeAtEnd(prefix);
  if (!fromPrefix) {
    return undefined;
  }

  return {
    filter: `${fromPrefix.filter} ${last}`,
    range: fromPrefix.range,
  };
}

export function toEditorRange(range: QueryRange): vscode.Range {
  return new vscode.Range(
    Math.max(0, range.startLine - 1),
    Math.max(0, range.startColumn - 1),
    Math.max(0, range.endLine - 1),
    Math.max(0, range.endColumn - 1),
  );
}
