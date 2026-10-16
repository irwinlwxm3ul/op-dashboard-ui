// opencc-js ships its dictionary data as untyped ES modules (default export: "src dst|src dst|…").
declare module 'opencc-js/dict/*' {
  const data: string;
  export default data;
}
