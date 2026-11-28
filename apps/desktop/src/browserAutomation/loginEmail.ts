export interface LoginFieldChoiceRequest {
  field: "username" | "email" | "password";
  prefix: string;
  formUsername?: string;
  acceptsPassword: boolean;
}

export interface LoginFieldChoice {
  username: string;
  password?: string;
}

export function isLoginEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[\w.!#$%&'*+/=?^`{|}~-]+@[\da-z](?:[\da-z-]*[\da-z])?(?:\.[\da-z](?:[\da-z-]*[\da-z])?)+$/iu.test(
      value,
    )
  );
}
