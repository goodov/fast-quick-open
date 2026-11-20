/** The most recent value shown in the Fast Quick Open input, across opens. */
let lastQuery = '';

export function getLastQuery(): string {
  return lastQuery;
}

export function setLastQuery(query: string): void {
  lastQuery = query;
}
