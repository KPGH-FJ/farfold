import { describe, expect, it } from "vitest";
import { LIBRARY } from "./library_strings";

/** W3-9：删除与归档共用同一套活跃度门禁；两套原因文案的键必须一一对应，
 *  否则某个被拦截的状态会在删除路径上失去用户可读原因。 */
describe("LIBRARY.deleteReasons", () => {
  it("covers every archive block reason", () => {
    expect(Object.keys(LIBRARY.deleteReasons).sort()).toEqual(
      Object.keys(LIBRARY.archiveReasons).sort(),
    );
  });
});
