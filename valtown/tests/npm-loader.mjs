export async function resolve(specifier, context, next) {
  if (specifier.startsWith("npm:")) {
    const rest = specifier.slice(4).replace(/^(@[^/]+\/[^@/]+|[^@/]+)@[^/]*/, "$1");
    return next(rest, context);
  }
  return next(specifier, context);
}
