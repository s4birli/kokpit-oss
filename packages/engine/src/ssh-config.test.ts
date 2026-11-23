import { describe, expect, it } from "vitest";
import { parseSshConfig } from "./ssh-config.ts";

describe("parseSshConfig", () => {
  it("parses concrete Host entries with their options", () => {
    const text = [
      "# comment",
      "Host oracle",
      "  HostName 1.2.3.4",
      "  User ubuntu",
      "  Port 2222",
      "  IdentityFile ~/.ssh/oracle_key",
      "",
      "Host plain",
    ].join("\n");
    expect(parseSshConfig(text)).toEqual([
      { alias: "oracle", hostname: "1.2.3.4", user: "ubuntu", port: 2222, identityFile: "~/.ssh/oracle_key" },
      { alias: "plain" },
    ]);
  });

  it("handles multiple aliases per Host line and shares options", () => {
    expect(parseSshConfig("Host a b\n User u\n")).toEqual([
      { alias: "a", user: "u" },
      { alias: "b", user: "u" },
    ]);
  });

  it("skips patterns, negations and Match blocks", () => {
    const text = [
      "Host *",
      "  User everyone",
      "Host web-? !bad good",
      "  User g",
      "Match host foo",
      "  User m",
      "Host after",
      "  Port 22",
    ].join("\n");
    expect(parseSshConfig(text)).toEqual([
      { alias: "good", user: "g" },
      { alias: "after", port: 22 },
    ]);
  });

  it("supports = syntax, case-insensitive keywords, tabs and CRLF", () => {
    const text = "host=x\r\n\tHOSTNAME = example.com\r\n\tuser\tme\r\n\tpOrT=10\r\n";
    expect(parseSshConfig(text)).toEqual([{ alias: "x", hostname: "example.com", user: "me", port: 10 }]);
  });

  it("first value wins within a block and first alias definition wins", () => {
    const text = ["Host d", " User first", " User second", "Host d", " User third", " Port 99"].join("\n");
    expect(parseSshConfig(text)).toEqual([{ alias: "d", user: "first" }]);
  });

  it("ignores Include and options before any Host", () => {
    const text = "User global\nInclude ~/.ssh/conf.d/*\nHost h\n";
    expect(parseSshConfig(text)).toEqual([{ alias: "h" }]);
  });

  it("strips quotes and trailing comments", () => {
    const text = 'Host "q"\n IdentityFile "~/.ssh/my key"\n User bob # trailing\n';
    expect(parseSshConfig(text)).toEqual([{ alias: "q", identityFile: "~/.ssh/my key", user: "bob" }]);
  });

  it("drops invalid ports", () => {
    expect(parseSshConfig("Host p\n Port 0\nHost q\n Port abc\nHost r\n Port 70000\n")).toEqual([
      { alias: "p" },
      { alias: "q" },
      { alias: "r" },
    ]);
  });

  it("never throws on garbage", () => {
    const pieces = ["Host", "Match", "=", '"', "#", " ", "\t", "\n", "\r", "*", "!", "Port", "HostName", "x", "\u0000", "é"];
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      let s = "";
      const n = rnd() % 40;
      for (let j = 0; j < n; j++) s += pieces[rnd() % pieces.length];
      const out = parseSshConfig(s);
      expect(Array.isArray(out)).toBe(true);
      for (const h of out) expect(h.alias).not.toMatch(/[*?!\s]/);
    }
    expect(parseSshConfig("")).toEqual([]);
    expect(parseSshConfig(undefined as unknown as string)).toEqual([]);
  });
});
