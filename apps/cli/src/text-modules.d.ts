// A guide page imported as text (`with { type: "text" }`): bun inlines it, compiled binary included.
declare module "*.mdx" {
  const text: string;
  export default text;
}
