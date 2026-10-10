import { expect, it } from "vitest";
import {
  formatVisualAreaPercent,
  parseVisualAreaPercent,
  validVisualAreaRect,
  visualAreaRectFromPoints,
} from "./visual_area_coordinates";

it.each([
  ["0", 0],
  ["0.0001", 1],
  ["1.2345", 12345],
  ["50.0010", 500010],
  ["99.9999", 999999],
  ["100", 1000000],
  ["100.0000", 1000000],
] as const)(
  "parses exact percentage %s without float rounding",
  (input, expected) => {
    expect(parseVisualAreaPercent(input)).toBe(expected);
    expect(parseVisualAreaPercent(formatVisualAreaPercent(expected))).toBe(
      expected,
    );
  },
);
it.each([
  "",
  " ",
  " 1",
  "1 ",
  "+1",
  "-0",
  "01",
  ".5",
  "1.",
  "1e2",
  "100%",
  "0.00001",
  "100.0001",
  "101",
  "Infinity",
  "NaN",
  "1,2",
])("rejects ambiguous/inexact numeric text %j", (input) => {
  expect(parseVisualAreaPercent(input)).toBeNull();
});
it.each([-1, 1000001, 0.1, NaN, Infinity])(
  "cannot format invalid fixed-point value %s",
  (n) => expect(formatVisualAreaPercent(n)).toBe(""),
);
it("uses the independent floor/ceil oracle and allows only pointer reverse direction", () => {
  expect(
    visualAreaRectFromPoints(
      { x: 0.7000001, y: 0.8000001 },
      { x: 0.1000001, y: 0.2000001 },
    ),
  ).toEqual({ left: 100000, top: 200000, right: 700001, bottom: 800001 });
  expect(
    validVisualAreaRect({
      left: 700001,
      top: 200000,
      right: 100000,
      bottom: 800001,
    }),
  ).toBe(false);
});
it("clips a crossing pointer drag to the complete image without using the outer box", () => {
  expect(visualAreaRectFromPoints({ x: -2, y: -1 }, { x: 3, y: 2 })).toEqual({
    left: 0,
    top: 0,
    right: 1000000,
    bottom: 1000000,
  });
});
it.each([
  [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
  ],
  [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.1 },
  ],
  [
    { x: -2, y: 0 },
    { x: -1, y: 1 },
  ],
  [
    { x: 2, y: 0 },
    { x: 3, y: 1 },
  ],
  [
    { x: 0, y: 2 },
    { x: 1, y: 3 },
  ],
  [
    { x: NaN, y: 0 },
    { x: 1, y: 1 },
  ],
  [
    { x: 0, y: 0 },
    { x: Infinity, y: 1 },
  ],
])(
  "rejects zero area before and after clipping and all nonfinite points",
  (a, b) => {
    expect(visualAreaRectFromPoints(a, b)).toBeNull();
  },
);
it("encloses a real subunit drag but never creates an area from identical points", () => {
  expect(
    visualAreaRectFromPoints(
      { x: 0.0000001, y: 0.0000001 },
      { x: 0.0000002, y: 0.0000002 },
    ),
  ).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
  expect(
    visualAreaRectFromPoints(
      { x: 0.0000001, y: 0.0000001 },
      { x: 0.0000001, y: 0.0000001 },
    ),
  ).toBeNull();
});
it.each([
  null,
  [],
  { left: 0, top: 0, right: 1, bottom: 1, kind: "image-area" },
  { left: 0, top: 0, right: 0, bottom: 1 },
  { left: 0, top: 0, right: 1, bottom: 1000001 },
  { left: "0", top: 0, right: 1, bottom: 1 },
  { left: 0, top: 0, right: 0.5, bottom: 1 },
])("requires the exact bounded rectangle object", (rect) =>
  expect(validVisualAreaRect(rect)).toBe(false),
);
