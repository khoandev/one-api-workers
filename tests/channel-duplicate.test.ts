import { expect, test } from "bun:test";
import { buildDuplicateChannelKey } from "../frontend/src/lib/channel-duplicate";

test("appends -copy when the key is free", () => {
    expect(buildDuplicateChannelKey("azure-gpt4", ["azure-gpt4", "openai"])).toBe("azure-gpt4-copy");
});

test("increments the suffix until the key is free", () => {
    expect(buildDuplicateChannelKey("chan", ["chan", "chan-copy"])).toBe("chan-copy-2");
    expect(buildDuplicateChannelKey("chan", ["chan", "chan-copy", "chan-copy-2"])).toBe("chan-copy-3");
});
