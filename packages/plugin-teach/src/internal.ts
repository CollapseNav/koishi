import { Context } from 'koishi-core'
import { DialogueFlag, Dialogue } from './database'
import { update } from './update'
import { RegExpValidator } from 'regexpp'
import leven from 'leven'

class RegExpError extends Error {
  name = 'RegExpError'
}

const validator = new RegExpValidator({
  onEscapeCharacterSet (start, end, kind, negate) {
    if (kind === 'space') throw negate
      ? new RegExpError('四季酱会自动删除问题中的空白字符，你无需使用 \\s。')
      : new RegExpError('四季酱会自动删除问题中的空白字符，请使用 . 代替 \\S。')
    let chars = kind === 'digit' ? '0-9' : '_0-9a-z'
    let source = kind === 'digit' ? 'd' : 'w'
    if (negate) {
      chars = '^' + chars
      source = source.toUpperCase()
    }
    throw new RegExpError(`目前不支持在正则表达式中使用 \\${source}，请使用 [${chars}] 代替。`)
  },
  onQuantifier (start, end, min, max, greedy) {
    if (!greedy) throw new RegExpError('目前不支持在正则表达式中使用非贪婪匹配语法。')
  },
  onWordBoundaryAssertion () {
    throw new RegExpError('目前不支持在正则表达式中使用单词边界。')
  },
  onLookaroundAssertionEnter () {
    throw new RegExpError('目前不支持在正则表达式中使用断言。')
  },
  onGroupEnter () {
    throw new RegExpError('目前不支持在正则表达式中使用非捕获组。')
  },
  onCapturingGroupEnter (start, name) {
    throw new RegExpError('目前不支持在正则表达式中使用具名组。')
  },
})

export default function apply (ctx: Context, config: Dialogue.Config) {
  ctx.command('teach')
    .option('--question <question>', '问题', { isString: true })
    .option('--answer <answer>', '回答', { isString: true })
    .option('-i, --ignore-hint', '忽略智能提示')
    .option('-x, --regexp', '使用正则表达式匹配', { authority: 3 })
    .option('-X, --no-regexp', '取消使用正则表达式匹配', { authority: 3 })
    .option('=>, --redirect-dialogue <answer>', '重定向到其他问答')

  ctx.before('dialogue/validate', (argv) => {
    const { options, meta, args } = argv
    if (args.length) {
      return meta.$send('存在多余的参数，请检查指令语法或将含有空格或换行的问答置于一对引号内。')
    }

    if (options.noRegexp) options.regexp = false

    const { answer } = options
    if (String(options.question).includes('[CQ:')) {
      return meta.$send('问题必须是纯文本。')
    }

    const { unprefixed, prefixed, appellative } = config._stripQuestion(options.question)
    argv.appellative = appellative
    Object.defineProperty(options, '_original', { value: prefixed })
    if (unprefixed) {
      options.original = options.question
      options.question = unprefixed
    } else {
      delete options.question
    }

    options.answer = (String(answer || '')).trim()
    if (!options.answer) delete options.answer
  })

  ctx.on('dialogue/before-fetch', ({ regexp, answer, question, original }, conditionals) => {
    const { escape } = ctx.database.mysql
    if (regexp) {
      if (answer !== undefined) conditionals.push('`answer` REGEXP ' + escape(answer))
      if (question !== undefined) conditionals.push('`question` REGEXP ' + escape(original))
    } else {
      if (answer !== undefined) conditionals.push('`answer` = ' + escape(answer))
      if (question !== undefined) {
        if (regexp === false) {
          conditionals.push('`question` = ' + escape(question))
        } else {
          conditionals.push(`(\
            !(\`flag\` & ${DialogueFlag.regexp}) && \`question\` = ${escape(question)} ||\
            \`flag\` & ${DialogueFlag.regexp} && (\
              ${escape(question)} REGEXP \`question\` || ${escape(original)} REGEXP \`question\`\
            )\
          )`)
        }
      }
    }
  })

  function isCloserToAnswer (dialogues: Dialogue[], question: string) {
    return dialogues.every(dialogue => {
      const dist = leven(question, dialogue.answer)
      return dist < dialogue.answer.length / 2
        && dist < leven(question, dialogue.question)
    })
  }

  ctx.on('dialogue/before-modify', async (argv) => {
    const { options, meta, target, dialogues } = argv
    const { question, answer, ignoreHint, regexp } = options

    // 错误的或不支持的正则表达式语法
    if (regexp || regexp !== false && question) {
      try {
        validator.validatePattern(question)
      } catch (err) {
        await meta.$send(err.name === 'RegExpError' ? err.message : '问题含有错误的或不支持的正则表达式语法。')
        return true
      }
    }

    // 修改问答时发现可能想改回答但是改了问题
    if (target && !ignoreHint && question && !answer && isCloserToAnswer(dialogues, question)) {
      meta.$app.onceMiddleware(async (meta, next) => {
        const message = meta.message.trim()
        if (message && message !== '.' && message !== '。') return next()
        options.answer = options.original
        delete options.question
        return update(argv)
      }, meta)
      await meta.$send('推测你想修改的是回答而不是问题。发送空行或句号以修改回答，添加 -i 选项以忽略本提示。')
      return true
    }
  })

  ctx.on('dialogue/before-create', async ({ options, meta, target }) => {
    // 添加问答时缺少问题或回答
    if (!target && !(options.question && options.answer)) {
      await meta.$send('缺少问题或回答，请检查指令语法。')
      return true
    }
  })

  ctx.before('dialogue/modify', ({ options }, data) => {
    if (options.answer) {
      data.answer = options.answer
    }

    if (options.regexp !== undefined) {
      data.flag &= ~DialogueFlag.regexp
      data.flag |= +options.regexp * DialogueFlag.regexp
    }

    if (options.question) {
      data.question = options.question
      data.original = options.original
    }
  })

  ctx.on('dialogue/validate', ({ options }) => {
    if (options.redirectDialogue) {
      options.answer = `\${dialogue ${options.answer}}`
    }
  })
}
