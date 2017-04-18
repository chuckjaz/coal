export function bindState(object: any, state: any): any {
  object._state = state;
  object._previous = state;
  object._transaction = currentTransactionNumber;
  state._object = object;
  state._min = currentTransactionNumber;
}

interface WithPredicessor {
  _previous: this;
}

interface TransactionSet {
  [index: number]: Boolean;
}

export type FrameState = "open" | "paused" | "aborted" | "committed";

export interface Frame {
  state: FrameState;
  onabort?: () => void;
  oncommit?: (changed: any[]) => void;
}

interface Transaction {
  number?: number;
  mutated?: any[];
  invalid?: TransactionSet;
  frame?: Frame;
}

let emptyObject = Object.freeze({});

let highestTransaction = 0;
let highestCommittedTransaction = 0;
let currentTransactionNumber = 0;
let currentTransaction: Transaction = emptyObject;
let openTransactions: FrameState[] = [];
let stateObjectsWithPredecessors: WithPredicessor[] = [];
let pausedTransactions: Transaction[] = [];

function assert(value: any): void {
  if (!value) throw Error("Invalid internal transaction state");
}

function inTransaction(): boolean {
  return !!currentTransaction.mutated;
}

function validateInTransaction() {
  if (!currentTransaction.mutated) throw new Error("No open transaction");
}

function validateNotInTransaction() {
  if (currentTransaction.mutated) throw new Error("Already in a transaction");
}

function assertInTransaction() {
  assert(currentTransaction.mutated);
}

function assertNotInTransaction() {
  assert(!currentTransaction.mutated);
}

function isValid(id: number|undefined, current: number, invalid: TransactionSet): boolean {
  if (id === undefined || id === null) return false;
  if (id <= current)
    return !invalid[id];
  return false;
}

export interface State {
  _min?: number;
  _max?: number;
  _previous: this;
  _entity: Entity<this>;
  clone?(): this;
  merge?(baseState: this, currentState: this): this;
}

export interface Entity<S extends State> {
  _transaction: number;
  _previous: S;
  _state: S;
  cloneState?(s: S): S;
  mergeState?(modifiedState: S, baseState: S, currentState: S): S;
}

function findVisible<S extends State>(state: S, transactionId: number, invalid: TransactionSet): S {
  if (!isValid(state._min, transactionId, invalid) || isValid(state._max, transactionId, invalid)) {
    // Find the first visible state
    state = state._previous;
    while (state && (!isValid(state._min, transactionId, invalid) || isValid(state._max, transactionId, invalid))) {
      state = state._previous;
    }
  }
  return state;
}

export function ensureReadable<S extends State>(entity: Entity<S>): void {
  if (entity._transaction !== currentTransactionNumber) makeReadable(entity);
}

function makeReadable<S  extends State>(entity: Entity<S>): void {
  let readableState = findVisible(entity._previous, currentTransactionNumber, currentTransaction.invalid || []);
  entity._state = readableState;
  entity._transaction = currentTransactionNumber;
}

export function ensureWritable<S extends State>(entity: Entity<S>): void {
  if (entity._transaction !== currentTransactionNumber || entity._state._min !== currentTransactionNumber)
    makeWritable(entity);
}

function clone<S extends State>(state: S): S {
  var newState = Object.create(state.constructor.prototype);
  for (const n in state) {
    if (n[0] != '_' && state.hasOwnProperty(n)) {
      newState[n] = state[n];
    }
  }
  return newState;
}

function currentInvalid(): TransactionSet {
  const result: TransactionSet = [];
  openTransactions.forEach((value, index) => {
    if (value === "open" || value === "aborted") {
      result[index] = true;
    }
  });
  return result;
}

function makeWritable<S extends State>(entity: Entity<S>) {
  validateInTransaction();
  ensureReadable(entity);
  const state = entity._state;
  const newState = state.clone ? state.clone() : (entity.cloneState || clone)(state);
  newState._min = currentTransactionNumber;
  newState._entity = entity;

  // Add the new state to the state list mainting sorted order of the states by _min
  let previous = entity._previous;
  let next: WithPredicessor = entity;
  while (previous && (previous._min || 0) > currentTransactionNumber) {
    next = previous;
    previous = previous._previous;
  }
  newState._previous = previous;
  next._previous = newState;

  state._max = currentTransactionNumber;
  entity._state = newState;
  currentTransaction.mutated!.push(newState);
  stateObjectsWithPredecessors.push(newState);
}

export function beginTransaction(oncommit?: (changed: any[]) => void , onabort?: () => void): Frame {
  validateNotInTransaction();
  currentTransactionNumber = ++highestTransaction;
  const invalid: TransactionSet = currentInvalid();
  const frame: Frame = { state: "open", oncommit, onabort };
  currentTransaction = { number: currentTransactionNumber, mutated: [], invalid, frame };
  openTransactions[currentTransactionNumber] = "open";
  assertInTransaction();
  return frame;
}

export function pauseTransaction(): number {
  validateInTransaction();
  const pausedId = pausedTransactions.length;
  pausedTransactions.push(currentTransaction);
  currentTransaction.frame!.state = "paused";
  currentTransaction = emptyObject;
  currentTransactionNumber = highestCommittedTransaction;
  assertNotInTransaction();
  return pausedId;
}

export function restoreTransaction(pausedId: number): void {
  assertNotInTransaction();
  const pausedTransaction = pausedTransactions[pausedId];
  if (!pausedTransaction || openTransactions[pausedTransaction.number!] !== "open") throw new Error("Invalid paused transaction");
  currentTransaction = pausedTransaction;
  currentTransaction.frame!.state = "open";
  currentTransactionNumber = pausedTransaction.number!;
  delete pausedTransactions[pausedId];
  assertInTransaction();
}

export function abortTransaction() {
  validateInTransaction();
  openTransactions[currentTransactionNumber] = "aborted";
  const frame = currentTransaction.frame!;
  frame.state = "aborted";
  currentTransactionNumber = highestCommittedTransaction;
  currentTransaction = emptyObject;
  scheduleCleanup();
  assertNotInTransaction();
  if (frame.onabort) frame.onabort;
}

export function commitTransaction(): any[] {
  const frame = currentTransaction.frame!;
  let mutated: any[] | null = null;
  try {
    validateInTransaction();
    const baseTransaction = currentTransactionNumber - 1;
    const baseInvalid = currentTransaction.invalid || [];
    try {
      mutated = currentTransaction.mutated!;
      const invalid = currentInvalid();
      mutated.forEach(state => {
        const first = state._entity._previous;
        const baseState = findVisible(first, baseTransaction, baseInvalid);
        const current = findVisible(first, highestCommittedTransaction, invalid);
        if (baseState !== current) {
          // Colliding update.
          throw new Error("Merge error");
        }
      })
    }
    catch (e) {
      abortTransaction();
      throw e;
    }

    delete openTransactions[currentTransactionNumber];
    if (currentTransactionNumber > highestCommittedTransaction)
      highestCommittedTransaction = currentTransactionNumber
    else
      currentTransactionNumber = highestCommittedTransaction;
    frame!.state = "committed";
    currentTransaction = emptyObject;
    scheduleCleanup();
  }
  finally {
    assertNotInTransaction();
  }
  if (frame.oncommit) frame.oncommit!(mutated);

  return mutated;
}

function scheduleCleanup() {

}