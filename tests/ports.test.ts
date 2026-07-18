import { expect, test } from "bun:test";
import { checkPorts } from "../scripts/check-ports";

test("no platform imports or surface wire tokens outside src/adapters/", () => {
  expect(checkPorts()).toEqual([]);
});
