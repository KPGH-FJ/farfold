import { expect, test } from "vitest";
import { parseWorkbook } from "./xlsx_parse";
import { workbookFixture } from "./xlsx_fixture";

interface Counts {
  someCalls: number;
  somePredicates: number;
  findCalls: number;
  findPredicates: number;
}
const original = {
  some: Object.getOwnPropertyDescriptor(Array.prototype, "some")!,
  find: Object.getOwnPropertyDescriptor(Array.prototype, "find")!,
};
function descriptorExact(name: "some" | "find"): boolean {
  const current = Object.getOwnPropertyDescriptor(Array.prototype, name)!;
  const before = original[name];
  return (
    current.value === before.value &&
    current.writable === before.writable &&
    current.enumerable === before.enumerable &&
    current.configurable === before.configurable &&
    current.get === before.get &&
    current.set === before.set
  );
}
function isColumnStyleArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0];
  return (
    !!first &&
    typeof first === "object" &&
    Object.keys(first).length === 3 &&
    Object.hasOwn(first, "min") &&
    Object.hasOwn(first, "max") &&
    Object.hasOwn(first, "style") &&
    Number.isInteger(first.min) &&
    Number.isInteger(first.max) &&
    Number.isInteger(first.style)
  );
}
type Predicate = (
  this: unknown,
  value: unknown,
  index: number,
  array: unknown[],
) => unknown;
function measured<T>(action: () => T): { value: T; counts: Counts } {
  const counts: Counts = {
    someCalls: 0,
    somePredicates: 0,
    findCalls: 0,
    findPredicates: 0,
  };
  for (const name of ["some", "find"] as const) {
    const native = original[name].value;
    Object.defineProperty(Array.prototype, name, {
      ...original[name],
      value: function (
        this: unknown[],
        callback: Predicate,
        thisArg?: unknown,
      ) {
        if (typeof callback !== "function" || !isColumnStyleArray(this))
          return Reflect.apply(native, this, arguments);
        if (name === "some") counts.someCalls++;
        else counts.findCalls++;
        return Reflect.apply(native, this, [
          function (
            this: unknown,
            item: unknown,
            index: number,
            receiver: unknown[],
          ) {
            if (name === "some") counts.somePredicates++;
            else counts.findPredicates++;
            return Reflect.apply(callback, this, [item, index, receiver]);
          },
          thisArg,
        ]);
      },
    });
  }
  try {
    const value = action();
    return { value, counts };
  } finally {
    Object.defineProperty(Array.prototype, "some", original.some);
    Object.defineProperty(Array.prototype, "find", original.find);
    expect(descriptorExact("some") && descriptorExact("find")).toBe(true);
  }
}
function columnName(column: number): string {
  let name = "";
  for (let n = column; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
function fixture(columns: number, rows: number, explicit = false) {
  return workbookFixture(
    Array.from(
      { length: rows },
      (_, i) =>
        `<row r="${i + 1}"><c r="${columnName(columns)}${i + 1}"${explicit ? ' s="0"' : ""}><v>1</v></c></row>`,
    ).join(""),
    {
      before: `<cols>${Array.from(
        { length: columns },
        (_, i) => `<col min="${i + 1}" max="${i + 1}" style="0" width="12"/>`,
      ).join("")}</cols>`,
    },
  );
}

test("real parser keeps column, row and explicit-cell style precedence and layout", () => {
  const input = workbookFixture(
    '<row r="1" customFormat="1" s="3"><c r="A1"><v>1</v></c><c r="B1"><v>1</v></c><c r="C1" s="0"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>1</v></c><c r="C2"><v>1</v></c></row>',
    {
      before:
        '<cols><col min="1" max="1" style="1" width="10"/><col min="3" max="4" style="2" hidden="1"/></cols>',
    },
  );
  const actual = parseWorkbook(input).sheet!;
  expect(
    actual.cells.map((cell) => [cell.reference, cell.styleId, cell.value]),
  ).toEqual([
    ["A1", 3, 1],
    ["B1", 3, 1],
    ["C1", 0, 1],
    ["A2", 1, 1],
    ["B2", 0, 1],
    ["C2", 2, 1],
  ]);
  expect(actual.columns).toEqual([
    { min: 1, max: 1, hidden: false, styleId: 1, width: 10 },
    { min: 3, max: 4, hidden: true, styleId: 2 },
  ]);
});

test("real parser accepts adjacent ranges and still rejects duplicate or overlapping ranges", () => {
  const input = (cols: string) =>
    workbookFixture('<row><c r="D1"><v>2</v></c></row>', {
      before: `<cols>${cols}</cols>`,
    });
  expect(
    parseWorkbook(
      input('<col min="1" max="2" style="1"/><col min="3" max="4" style="2"/>'),
    ).sheet!.cells[0].styleId,
  ).toBe(2);
  for (const cols of [
    '<col min="1" max="2"/><col min="2" max="3"/>',
    '<col min="1" max="2"/><col min="1" max="2"/>',
  ])
    expect(() => parseWorkbook(input(cols))).toThrowError("invalid");
});

test("explicit cell styles avoid looking up an unused column fallback", () => {
  const input = fixture(128, 4, true);
  const { value, counts } = measured(() => parseWorkbook(input));
  expect(value.sheet!.cells.map((cell) => [cell.styleId, cell.value])).toEqual([
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
  ]);
  expect(counts.findPredicates).toBe(0);
});

test("ordinary independent column and cell counts do not multiply interval predicates", () => {
  const columns = 1024,
    rows = 1024;
  const input = fixture(columns, rows);
  const { value, counts } = measured(() => parseWorkbook(input));
  expect(value.sheet!.columns).toHaveLength(columns);
  expect(value.sheet!.cells).toHaveLength(rows);
  expect(value.sheet!.cells[0]).toMatchObject({
    reference: "AMJ1",
    styleId: 0,
    value: 1,
  });
  expect(value.sheet!.cells.at(-1)).toMatchObject({
    reference: "AMJ1024",
    styleId: 0,
    value: 1,
  });
  // Logical native predicate invocations only. This is neither a wall-clock
  // assertion nor a claim to count every future indexing algorithm's work.
  const allowance = 64 * (columns + rows);
  expect(counts.somePredicates + counts.findPredicates).toBeLessThanOrEqual(
    allowance,
  );
});

test("unsorted ranges retain layout order, gaps, the last column and row style zero", () => {
  const parsed = parseWorkbook(
    workbookFixture(
      '<row r="1"><c r="XFD1"><v>1</v></c><c r="B1"><v>1</v></c><c r="A1"><v>1</v></c></row>' +
        '<row r="2" customFormat="1" s="0"><c r="A2"><v>1</v></c><c r="XFD2" s="3"><v>1</v></c></row>',
      {
        before:
          '<cols><col min="16384" max="16384" style="2" width="15"/><col min="1" max="1" style="1" hidden="1"/></cols>',
      },
    ),
  ).sheet!;
  expect(
    parsed.columns.map(({ min, max, styleId }) => [min, max, styleId]),
  ).toEqual([
    [16384, 16384, 2],
    [1, 1, 1],
  ]);
  expect(
    parsed.cells.map(({ reference, styleId }) => [reference, styleId]),
  ).toEqual([
    ["A1", 1],
    ["B1", 0],
    ["XFD1", 2],
    ["A2", 0],
    ["XFD2", 3],
  ]);
});

test("a full default-style range covers both boundaries and still rejects overlap", () => {
  const input = (extra: string) =>
    workbookFixture(
      '<row><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>',
      { before: `<cols><col min="1" max="16384" style="0"/>${extra}</cols>` },
    );
  expect(
    parseWorkbook(input("")).sheet!.cells.map(({ styleId }) => styleId),
  ).toEqual([0, 0]);
  for (const column of [1, 16384])
    expect(() =>
      parseWorkbook(input(`<col min="${column}" max="${column}"/>`)),
    ).toThrowError("invalid");
});
