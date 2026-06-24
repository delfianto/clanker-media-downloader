import { describe, it, expect } from "bun:test";
import { parseSet, deriveGalleryName } from "../src/hosts/girlsreleased/api";

// 2020-01-01 00:00:00 UTC
const TS_2020 = 1577836800;

function setWith(date: unknown) {
  return {
    set: [
      1,
      "Set",
      date,
      "site.com",
      [[0, 0, 0, "https://imx.to/i/a", "https://imx.to/u/t/a.jpg", "a.jpg"]],
      [],
    ],
  };
}

describe("parseSet", () => {
  it("parses a full set with date, model, and multiple files", () => {
    const parsed = parseSet({
      set: [
        147671,
        "Stranden",
        TS_2020,
        "errotica-archives.com",
        [
          [0, 0, 0, "https://imx.to/i/abc", "https://imx.to/u/t/x/abc.jpg", "img_001.jpg"],
          [
            0,
            0,
            0,
            "https://imagevenue.com/xyz",
            "https://imagevenue.com/t/xyz.jpg",
            "img_002.jpg",
          ],
        ],
        [[5208, "Deni"]],
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("Stranden");
    expect(parsed?.site).toBe("errotica-archives.com");
    expect(parsed?.model).toBe("Deni");
    expect(parsed?.postedAt).toBe(TS_2020);
    expect(parsed?.files).toHaveLength(2);
    expect(parsed?.files[0]).toEqual({
      viewerUrl: "https://imx.to/i/abc",
      thumbnailUrl: "https://imx.to/u/t/x/abc.jpg",
      filename: "img_001.jpg",
    });
  });

  it("parses a full set in version 0.2 format", () => {
    const parsed = parseSet({
      status: 0,
      set: {
        name: "Stranden",
        url: null,
        date: TS_2020,
        site: "errotica-archives.com",
        models: [[5208, "Deni"]],
        id: "147671",
        images: [
          [0, 0, 0, "https://imx.to/i/abc", "https://imx.to/u/t/x/abc.jpg", "img_001.jpg"],
          [
            0,
            0,
            0,
            "https://imagevenue.com/xyz",
            "https://imagevenue.com/t/xyz.jpg",
            "img_002.jpg",
          ],
        ],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("Stranden");
    expect(parsed?.site).toBe("errotica-archives.com");
    expect(parsed?.model).toBe("Deni");
    expect(parsed?.postedAt).toBe(TS_2020);
    expect(parsed?.files).toHaveLength(2);
    expect(parsed?.files[0]).toEqual({
      viewerUrl: "https://imx.to/i/abc",
      thumbnailUrl: "https://imx.to/u/t/x/abc.jpg",
      filename: "img_001.jpg",
    });
  });

  it("yields postedAt = null for an absent / null / implausible date slot", () => {
    expect(parseSet(setWith(null))?.postedAt).toBeNull();
    expect(parseSet(setWith(0))?.postedAt).toBeNull(); // epoch, before the 2000 floor
    expect(parseSet(setWith(5))?.postedAt).toBeNull(); // looks like a count, not a date
    expect(parseSet(setWith("not a number"))?.postedAt).toBeNull();
    const farFuture = Math.floor(Date.now() / 1000) + 10 * 365 * 86400;
    expect(parseSet(setWith(farFuture))?.postedAt).toBeNull();
  });

  it("accepts a string timestamp and tolerates millisecond values", () => {
    expect(parseSet(setWith(String(TS_2020)))?.postedAt).toBe(TS_2020);
    expect(parseSet(setWith(TS_2020 * 1000))?.postedAt).toBe(TS_2020);
  });

  it("keeps a set whose models element is absent (length 5)", () => {
    const parsed = parseSet({
      set: [
        1,
        "Set",
        TS_2020,
        "site.com",
        [[0, 0, 0, "https://imx.to/i/a", "https://imx.to/u/t/a.jpg", "a.jpg"]],
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.model).toBe("");
    expect(parsed?.files).toHaveLength(1);
  });

  it("keeps a file with no originalFilename, deriving it from the viewer URL slug", () => {
    const parsed = parseSet({
      set: [
        1,
        "Set",
        TS_2020,
        "site.com",
        [[0, 0, 0, "https://imx.to/i/abc123", "https://imx.to/u/t/abc123.jpg"]],
        [],
      ],
    });
    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.files[0]?.filename).toBe("abc123");
  });

  it("skips files lacking both viewer and thumbnail URLs", () => {
    const parsed = parseSet({
      set: [
        1,
        "Set",
        TS_2020,
        "site.com",
        [
          [0, 0, 0, "", "", ""],
          [0, 0, 0, "https://imx.to/i/ok", "https://imx.to/u/t/ok.jpg", "ok.jpg"],
        ],
        [],
      ],
    });
    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.files[0]?.viewerUrl).toBe("https://imx.to/i/ok");
  });

  it("returns null for invalid shapes", () => {
    expect(parseSet(null)).toBeNull();
    expect(parseSet(undefined)).toBeNull();
    expect(parseSet("not an object")).toBeNull();
    expect(parseSet(42)).toBeNull();
    expect(parseSet({})).toBeNull();
    expect(parseSet({ set: "not an array" })).toBeNull();
    expect(parseSet({ set: [1, "name", null] })).toBeNull(); // too short (< 5)
    expect(parseSet({ set: [1, "name", null, "site", "files-not-array"] })).toBeNull();
  });
});

describe("deriveGalleryName", () => {
  it("prepends YYYY.MM.DD_HH.MM.SS and dots spaces when a posted timestamp is given", () => {
    expect(deriveGalleryName("femjoy.com", "Ariel A", "Sway", TS_2020)).toBe(
      "Femjoy/2020.01.01_00.00.00_Ariel.A_Sway",
    );
  });

  it("zero-pads the time components (UTC)", () => {
    // 2020-01-02 03:04:05 UTC
    expect(deriveGalleryName("x.com", "", "S", 1577934245)).toBe("X/2020.01.02_03.04.05_S");
  });

  it("omits the date segment when postedAt is null/absent", () => {
    expect(deriveGalleryName("femjoy.com", "Ariel A", "Sway")).toBe("Femjoy/Ariel.A_Sway");
    expect(deriveGalleryName("femjoy.com", "Ariel A", "Sway", null)).toBe("Femjoy/Ariel.A_Sway");
  });

  it("omits the model segment when model is empty", () => {
    expect(deriveGalleryName("femjoy.com", "", "Sway", TS_2020)).toBe(
      "Femjoy/2020.01.01_00.00.00_Sway",
    );
    expect(deriveGalleryName("femjoy.com", "", "Sway")).toBe("Femjoy/Sway");
  });

  it("returns just the set segment when site is empty", () => {
    expect(deriveGalleryName("", "", "Sway", TS_2020)).toBe("2020.01.01_00.00.00_Sway");
    expect(deriveGalleryName("", "Model", "Sway")).toBe("Model_Sway");
  });

  it("strips the TLD and capitalizes the studio", () => {
    expect(deriveGalleryName("errotica-archives.com", "", "Set")).toBe("Errotica-archives/Set");
    expect(deriveGalleryName("met-art.com", "", "X")).toBe("Met-art/X");
  });

  it("collapses consecutive slashes/spaces and converts slashes/spaces in model/name to dots/underscores", () => {
    expect(deriveGalleryName("x.com", "Two Words", "A / B / C")).toBe("X/Two.Words_A.B.C");
  });
});
