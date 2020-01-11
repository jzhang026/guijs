import gql from 'graphql-tag'
import lunr from 'elasticlunr'
import consola from 'consola'
import { withFilter } from 'apollo-server-express'
import { Resolvers, CommandType } from '@/generated/schema'
import Context from '@/generated/context'
import { MetaCommand } from './meta-types'
import { keybindings, addKeybinding } from '../keybinding'

export const typeDefs = gql`
type Command {
  id: ID!
  type: CommandType!
  label: String!
  icon: String
  description: String
  keybinding: Keybinding
}

enum CommandType {
  help
  action
  project
  package
  config
  script
}

extend type Query {
  searchCommands(text: String!): [Command!]!
}

extend type Mutation {
  runCommand(id: ID!): Command
}

type Subscription {
  commandRan: Command
}
`

export const commands: MetaCommand[] = []
export const commandsMap: Map<string, MetaCommand> = new Map()

function createIndex () {
  return lunr<MetaCommand>(function () {
    this.addField('label')
    this.setRef('id')
    this.saveDocument(false)
  })
}

const searchIndexes: {[key in CommandType]?: lunr.Index<MetaCommand>} = {}
for (const key in CommandType) {
  searchIndexes[CommandType[key]] = createIndex()
}
const globalSearchIndex = createIndex()

export function addCommand (cmd: MetaCommand) {
  commands.push(cmd)
  commandsMap.set(cmd.id, cmd)
  if (!cmd.hidden) {
    searchIndexes[cmd.type].addDoc(cmd)
    globalSearchIndex.addDoc(cmd)
  }
}

const typeWords = {
  '?': CommandType.Help,
  '>': CommandType.Action,
  '<': CommandType.Project,
  '&': CommandType.Package,
  '~': CommandType.Config,
  '$': CommandType.Script,
}

const typeWordReg = new RegExp(`^(${Object.keys(typeWords).map(w => `\\${w}`).join('|')})`)

function getSeachType (text: string) {
  const result = typeWordReg.exec(text)
  if (result) {
    return typeWords[result[1]]
  }
  return null
}

export function searchCommands (text: string) {
  let searchIndex = globalSearchIndex
  const type = getSeachType(text)
  if (type) {
    searchIndex = searchIndexes[type]
    text = text.substr(1)
  }

  if (!text.length) {
    return getRecentCommands(type)
  }

  const results = searchIndex.search(text, {
    fields: {
      label: { boost: 2, expand: true },
    },
  })
  return results.map(r => commandsMap.get(r.ref))
}

function getRecentCommands (type: string = null) {
  let list = commands
  if (type) {
    list = list.filter(c => !c.hidden && c.type === type)
  } else {
    list = list.filter(c => !c.hidden && c.type !== CommandType.Help).slice()
  }
  list.sort((a, b) => {
    if (a.lastUsed && b.lastUsed) {
      return b.lastUsed.getTime() - a.lastUsed.getTime()
    } else if (a.lastUsed) {
      return -1
    } else if (b.lastUsed) {
      return 1
    }
    return 0
  })
  return list.slice(0, 20)
}

export function runCommand (id: string, ctx: Context) {
  const command = commands.find(c => c.id === id)
  if (!command) {
    consola.warn(`Command ${id} not found`)
    return null
  }
  if (command.handler) {
    command.handler()
  }
  ctx.pubsub.publish('commandRan', {
    commandRan: command,
    clientId: ctx.getClientId(),
  })
  return command
}

export const resolvers: Resolvers = {
  Command: {
    keybinding: command => keybindings.find(k => k.id === command.id),
  },

  Query: {
    searchCommands: (root, { text }) => searchCommands(text),
  },

  Mutation: {
    runCommand: (root, { id }, ctx) => runCommand(id, ctx),
  },

  Subscription: {
    commandRan: {
      subscribe: withFilter(
        (root, args, ctx) => ctx.pubsub.asyncIterator(['commandRan']),
        (payload, variables, context: Context) => {
          return payload.clientId === context.getClientId()
        },
      ),
    },
  },
}

// Help commands
for (const word in typeWords) {
  if (word === '?') continue
  addCommand({
    id: word,
    type: CommandType.Help,
    label: word,
    description: `guijs.find.help.${typeWords[word]}`,
  })
}

// Internal commands
addCommand({
  id: 'find',
  type: CommandType.Action,
  label: 'Find',
  hidden: true,
})

addKeybinding({
  id: 'find',
  sequences: ['mod+p', 'mod+k'],
  scope: 'root',
  global: true,
})

addCommand({
  id: 'command',
  type: CommandType.Action,
  label: 'Command',
  hidden: true,
})

addKeybinding({
  id: 'command',
  sequences: ['mod+shift+p', 'mod+shift+k'],
  scope: 'root',
  global: true,
})