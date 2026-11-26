export function isLoginEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[\w.!#$%&'*+/=?^`{|}~-]+@[\da-z](?:[\da-z-]*[\da-z])?(?:\.[\da-z](?:[\da-z-]*[\da-z])?)+$/iu.test(
      value,
    )
  );
}
