const REFLECT_APPLY = Reflect.apply;
const DATE_GET_TIME: (this: Date) => number = Reflect.get(
  Date.prototype,
  "getTime",
);

export function getDateTime(value: Date): number {
  return REFLECT_APPLY(DATE_GET_TIME, value, []);
}
