import { describe, expect, it } from "vitest";
import { daysBetween, formatDay, relativeDayName, shiftDate } from "./dates.ts";

describe("todo dates", () => {
  it("shifts across month, year, leap day and DST weekends", () => {
    expect(shiftDate("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-03-28", 2)).toBe("2026-03-30"); // EU DST change
    expect(shiftDate("2026-11-01", 1)).toBe("2026-11-02"); // US DST end
  });

  it("names nearby days", () => {
    expect(relativeDayName("2026-11-16", "2026-11-16")).toBe("Bugün");
    expect(relativeDayName("2026-11-15", "2026-11-16")).toBe("Dün");
    expect(relativeDayName("2026-11-17", "2026-11-16")).toBe("Yarın");
    expect(relativeDayName("2026-11-20", "2026-11-16")).toBeNull();
    expect(daysBetween("2026-11-10", "2026-11-16")).toBe(6);
  });

  it("formats in Turkish", () => {
    expect(formatDay("2026-11-16", "tr-TR")).toBe("16 Kasım 2026 Pazartesi");
  });
});
