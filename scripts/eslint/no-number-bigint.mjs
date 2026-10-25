// Number(x) where x is a bigint: exact only up to 2^53, and Hermes (React Native) returns garbage at
// and above 2^63. Money stays bigint; display goes through core's bigintToNumber / bigintToUnits.
import ts from 'typescript'

const isBigIntish = (type) =>
  (type.flags & ts.TypeFlags.BigIntLike) !== 0 || (type.isUnion() && type.types.some(isBigIntish))

/** A bigint literal no larger than 2^53. */
const smallLiteral = (n) => n?.type === 'Literal' && typeof n.bigint === 'string' && BigInt(n.bigint) <= 2n ** 53n
/** `x & 0xffn`, `x % 58n`: bounded by the literal, so Number() is exact on every engine. */
const boundedByLiteral = (n) =>
  n.type === 'BinaryExpression' && ((n.operator === '&' && (smallLiteral(n.left) || smallLiteral(n.right))) || (n.operator === '%' && smallLiteral(n.right)))

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Number() on a bigint (lossy above 2^53, wrong on Hermes above 2^63).' },
    messages: {
      lossy: 'Number() on a bigint is lossy above 2^53 and returns garbage on Hermes above 2^63. Keep it bigint, use bigintToNumber / bigintToUnits from @anywalletkit/core, or Number(x.toString()) for a value bounded small (say why).',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services?.program) return {}
    const checker = services.program.getTypeChecker()
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'Number' || node.arguments.length !== 1) return
        const arg = node.arguments[0]
        if (arg.type === 'SpreadElement' || boundedByLiteral(arg)) return
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(arg))
        if (isBigIntish(type)) context.report({ node, messageId: 'lossy' })
      },
    }
  },
}
