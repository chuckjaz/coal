import {
  beginTransaction,
  abortTransaction,
  commitTransaction,
  pauseTransaction,
  restoreTransaction,
  bindState,
  ensureReadable,
  ensureWritable
} from '../index';


// Execute f in a transaction, abort if an exception is thrown, otherwise commit.
function transaction(f: () => void): any[] {
  beginTransaction();
  try {
    f();
  }
  catch (e) {
    abortTransaction();
    throw e;
  }
  return commitTransaction();
}

// Execute f in a transaction then pause it.
function paused(f: () => void): number {
  beginTransaction();
  try {
    f();
  }
  catch (e) {
    abortTransaction();
    throw e;
  }
  return pauseTransaction();
}

// Continue a previously paused transaction, then pause it again.
function continued(pauseId: number, f: () => void): number {
  restoreTransaction(pauseId);
  try {
    f();
  }
  catch (e) {
    abortTransaction();
    throw e;
  }
  return pauseTransaction();
}

// Unpause a transaction, execute f in that transaction (if given), then commit the transaction.
function unpaused(pauseId: number, f?: () => void): any[] {
  restoreTransaction(pauseId);
  if (f) {
    try {
      f();
    }
    catch (e) {
      abortTransaction();
      throw e;
    }
  }
  return commitTransaction();
}

// Unpause and abort a paused transaction.
function abortPaused(pauseId: number): void {
  restoreTransaction(pauseId);
  abortTransaction();
}

// A simple model
function model<T>(object: T): T {
    var s: any = {};
    var m: T = <any>{};
    bindState(m, s);
    var names = Object.getOwnPropertyNames(object)
    names.forEach(function (name) {
        Object.defineProperty(m, name, {
            get: function () {
                ensureReadable(this);
                return this._state[name];
            },
            set: function (value) {
                ensureWritable(this);
                this._state[name] = value;
            },
            enumerable: true
        });
        s[name] = (object as any)[name];
    });
    return m;
}

function expect<T>(a: T, b: T): void {
  if (a !== b) {
    throw new Error(`Expected ${a}, received ${b}`);
  }
}

function entity<T extends Function>(target: T): T {
  const f: T = <any>function(/*...arguments: any[]*/) {
    bindState(this, {});
    target.apply(this, arguments);
  };
  f.prototype = target.prototype;
  f.prototype.constructor = f;
  return f;
}

function state(target: any, propertyKey: any) {
  Object.defineProperty(target, propertyKey, {
    get: function() {
      ensureReadable(this);
      return this._state[propertyKey];
    },
    set: function(value) {
      ensureWritable(this);
      this._state[propertyKey] = value;
    }
  });
}

describe('Model', () => {
  interface Person {
    name: string;
    occupation: string;
  }

  it("should support creating a model", () => {
    let m: Person;
    transaction(() => {
      m = model({
        name: "Jim Henson",
        occupation: "Puppeteer"
      });
      expect("Jim Henson", m.name);
      expect("Puppeteer", m.occupation);
    });
    transaction(() => {
      expect("Jim Henson", m.name);
      expect("Puppeteer", m.occupation);
    });
  });

  it("should be able to update a model", () => {
    let m: Person;
    transaction(function () {
      m = model({
        name: "Jim Carrey",
        occupation: "Waiter"
      });
    });
    transaction(function () {
      m.occupation = "Actor";
    });
    transaction(function () {
      expect("Jim Carrey", m.name);
      expect("Actor", m.occupation);
    });
  });

  it("should abort for an exception", () => {
    let m: Person;
    transaction(function () {
      m = model({
        name: "Jim Carrey",
        occupation: "Waiter"
      });
    });
    try {
      transaction(function () {
        m.occupation = "Actor";
        throw new Error();
      });
    }
    catch (e) {
    }
    transaction(function () {
      expect("Jim Carrey", m.name);
      expect("Waiter", m.occupation);
    });
  });

  it("should be able to pause and unpause a transaction", () => {
    let m: Person;
    transaction(function () {
      m = model({
        name: "Jim Carrey",
        occupation: "Waiter"
      });
    });
    const pauseId = paused(function () {
      m.occupation = "Actor";
    });
    transaction(function () {
      expect("Waiter", m.occupation);
    });
    unpaused(pauseId, function () {
      expect(m.occupation, "Actor");
    });
    transaction(function () {
      expect("Actor", m.occupation);
    });
  });

  it("should isolate transactions from each other", () => {
    interface Book {
      name: string;
      author: string;
      price: number;
    }

    let m: Book;
    transaction(function () {
      m = model({
        name: "Moby Dick",
        author: "Herman Melville",
        price: 4.99
      });
    });
    let t1 = paused(function () {
      m.price = 5.99;
    });
    let t2 = paused(function () {
      m.price = 6.99;
    });
    t1 = continued(t1, function () {
      expect(5.99, m.price);
    });
    t2 = continued(t2, function () {
      expect(6.99, m.price);
    });
    transaction(function () {
      expect(4.99, m.price);
    });
    unpaused(t1);
    transaction(function () {
      expect(5.99, m.price);
    });
    abortPaused(t2);
    transaction(function () {
      expect(5.99, m.price);
    });
  });
});

describe('Entity', () => {
  @entity
  class Person {
    @state name: string;
    @state occupation: string;

    constructor(name: string, occupation: string) {
      this.name = name;
      this.occupation = occupation;
    }
  }

  it("should support creating an entity", () => {
    let m: Person;
    transaction(() => {
      m = new Person("Jim Henson", "Puppeteer");
      expect("Jim Henson", m.name);
      expect("Puppeteer", m.occupation);
    });
    transaction(() => {
      expect("Jim Henson", m.name);
      expect("Puppeteer", m.occupation);
    });
  });

  it("should be able to update an entity", () => {
    var m: Person;
    transaction(function () {
      m = new Person("Jim Carrey", "Waiter");
    });
    transaction(function () {
      m.occupation = "Actor";
    });
    transaction(function () {
      expect("Jim Carrey", m.name);
      expect("Actor", m.occupation);
    });
  });

  it("should abort for an exception", () => {
    var m: Person;
    transaction(function () {
      m = new Person("Jim Carrey", "Waiter");
    });
    try {
      transaction(function () {
        m.occupation = "Actor";
        throw new Error();
      });
    }
    catch (e) {
    }
    transaction(function () {
      expect("Jim Carrey", m.name);
      expect("Waiter", m.occupation);
    });
  });

  it("should be able to pause and unpause a transaction", () => {
    var m: Person;
    transaction(function () {
      m = new Person("Jim Carrey", "Waiter");
    });
    var pauseId = paused(function () {
      m.occupation = "Actor";
    });
    transaction(function () {
      expect("Waiter", m.occupation);
    });
    unpaused(pauseId, function () {
      expect(m.occupation, "Actor");
    });
    transaction(function () {
      expect("Actor", m.occupation);
    });
  });

  @entity
  class Book {
    @state name: string;
    @state author: string;
    @state price: number;

    constructor(name: string, author: string, price: number) {
      this.name = name;
      this.author = author;
      this.price = price;
    }
  }

  it("should isolate transactions from each other", () => {
    let m: Book;
    transaction(function () {
      m = new Book("Moby Dick", "Herman Melville", 4.99);
    });
    let t1 = paused(function () {
      m.price = 5.99;
    });
    let t2 = paused(function () {
      m.price = 6.99;
    });
    t1 = continued(t1, function () {
      expect(5.99, m.price);
    });
    t2 = continued(t2, function () {
      expect(6.99, m.price);
    });
    transaction(function () {
      expect(4.99, m.price);
    });
    unpaused(t1);
    transaction(function () {
      expect(5.99, m.price);
    });
    abortPaused(t2);
    transaction(function () {
      expect(5.99, m.price);
    });
  });
});