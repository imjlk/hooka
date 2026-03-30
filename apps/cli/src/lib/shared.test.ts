import { expect, mock, test } from "bun:test";
import { withClosable } from "./shared";

test("withClosable closes the resource after a successful callback", async () => {
  const close = mock(() => {});
  const result = await withClosable(
    Promise.resolve({
      close,
    }),
    async () => "ok",
  );

  expect(result).toBe("ok");
  expect(close).toHaveBeenCalledTimes(1);
});

test("withClosable closes the resource when the callback throws", async () => {
  const close = mock(() => {});

  await expect(
    withClosable(
      Promise.resolve({
        close,
      }),
      async () => {
        throw new Error("boom");
      },
    ),
  ).rejects.toThrow("boom");

  expect(close).toHaveBeenCalledTimes(1);
});
