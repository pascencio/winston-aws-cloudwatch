// const { PutLogEventsCommand, CreateLogGroupCommand, CreateLogStreamCommand, DescribeLogStreamsCommand } = require('@aws-sdk/client-cloudwatch-logs')
const CloudWatchClient = require('../../lib/cloudwatch-client')
const LogItem = require('../../lib/log-item')

const logGroupName = 'testGroup'
const logStreamName = 'testStream'

// let tokens = 0
// let streams = 0

// const withPromise = res => ({ promise: () => res })

// const mapRequest = (_, includeExpected, token, nextToken) => {
//   const suffixes = [++streams, ++streams, includeExpected ? '' : ++streams]
//   const res = Promise.resolve({
//     logStreams: suffixes.map(suf => ({ logStreamName: logStreamName + suf })),
//     nextToken
//   })
//   if (token) {
//     // stub.withArgs(sinon.match({ nextToken: token })).returns(withPromise(res))
//     return withPromise(res)
//   } else {
//     // stub.returns(withPromise(res))
//     return withPromise(res)
//   }
// }

// const mapRequests = (stub, pages, includeExpected) => {
//   let prevToken = null
//   for (let i = 0; i < pages - 1; ++i) {
//     const token = 'token' + ++tokens
//     mapRequest(stub, false, prevToken, token)
//     prevToken = token
//   }
//   mapRequest(stub, includeExpected, prevToken)
// }

const createErrorWithCode = code => {
  const error = new Error('Whoopsie daisies')
  error.code = code
  return error
}

const streamsStrategies = {
  default: 'default',
  notFound: 'notFound',
  paged: 'paged',
  pagedNotFound: 'pagedNotFound'
}

const createStreamsResponse = (option, command) => {
  switch (option) {
    case streamsStrategies.default:
      return Promise.resolve({
        logStreams: [{ logStreamName }],
        nextToken: null
      })
    case streamsStrategies.paged:
      if (command.nextToken) {
        return Promise.resolve({
          logStreams: [{ logStreamName }],
          nextToken: null
        })
      }
      return Promise.resolve({
        logStreams: [{ logStreamName }],
        nextToken: 'token2'
      })
    case streamsStrategies.pagedNotFound:
      return Promise.reject(new Error('Log stream not found'))
    case streamsStrategies.notFound:
      return Promise.reject(new Error('Log stream not found'))
    default:
      throw new Error(`Unknown streams strategy: ${option}`)
  }
}

const createClient = options => {
  options = Object.assign(
    {
      clientOptions: null,
      streamsStrategy: streamsStrategies.default,
      groupErrorCode: null,
      streamErrorCode: false,
      putRejectionCode: null
    },
    options
  )
  const client = new CloudWatchClient(
    logGroupName,
    logStreamName,
    options.clientOptions
  )
  let putPromise
  if (options.putRejectionCode != null) {
    const err = new Error()
    err.code = options.putRejectionCode
    putPromise = Promise.reject(err)
  } else {
    putPromise = Promise.resolve({ nextSequenceToken: 'token42' })
  }
  sinon.stub(client._client, 'send').callsFake(command => {
    if (command.constructor.name === 'PutLogEventsCommand') {
      return putPromise
    } else if (command.constructor.name === 'CreateLogGroupCommand') {
      return options.groupErrorCode
        ? Promise.reject(createErrorWithCode(options.groupErrorCode))
        : Promise.resolve()
    } else if (command.constructor.name === 'CreateLogStreamCommand') {
      return options.streamErrorCode
        ? Promise.reject(createErrorWithCode(options.streamErrorCode))
        : Promise.resolve()
    } else if (command.constructor.name === 'DescribeLogStreamsCommand') {
      return createStreamsResponse(options.streamsStrategy, command)
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`)
  })
  return client
}

const createBatch = size => {
  const batch = []
  for (let i = 0; i < size; ++i) {
    batch.push(
      new LogItem(+new Date(), 'info', 'Test', { foo: 'bar' }, () => {})
    )
  }
  return batch
}

describe('CloudWatchClient', () => {
  describe('#submit()', () => {
    it('calls putLogEvents', () => {
      const client = createClient()
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => client._client.send.callCount)
      ).to.eventually.equal(2)
    })

    it('handles log stream paging', () => {
      const client = createClient({
        streamsStrategy: streamsStrategies.paged
      })
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => client._client.send.callCount)
      ).to.eventually.equal(2)
    })

    it('rejects after retrying upon InvalidSequenceTokenException', () => {
      const client = createClient({
        putRejectionCode: 'InvalidSequenceTokenException'
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.rejectedWith(
        'Invalid sequence token, will retry'
      )
    })

    it('rejects if the log stream is not found in a single page', () => {
      const client = createClient({
        streamsStrategy: streamsStrategies.notFound
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.rejected
    })

    it('rejects if the log stream is not found in multiple pages', () => {
      const client = createClient({
        streamsStrategy: streamsStrategies.pagedNotFound
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.rejected
    })
  })

  describe('#options.formatLog', () => {
    it('uses the custom formatter', () => {
      const formatLog = sinon.spy(item => {
        return `CUSTOM__${JSON.stringify(item)}`
      })
      const client = createClient({
        clientOptions: { formatLog }
      })
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => formatLog.calledOnce)
      ).to.eventually.equal(true)
    })
  })

  describe('#options.formatLogItem', () => {
    it('uses the custom formatter', () => {
      const formatLogItem = sinon.spy(item => {
        return {
          timestamp: item.date,
          message: `CUSTOM__${JSON.stringify(item)}`
        }
      })
      const client = createClient({
        clientOptions: { formatLogItem }
      })
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => formatLogItem.calledOnce)
      ).to.eventually.equal(true)
    })

    it('does not use the custom formatter if formatLog is specified', () => {
      const formatLog = sinon.spy(item => {
        return `CUSTOM__${JSON.stringify(item)}`
      })
      const formatLogItem = sinon.spy(item => {
        return {
          timestamp: item.date,
          message: `CUSTOM__${JSON.stringify(item)}`
        }
      })
      const client = createClient({
        clientOptions: { formatLog, formatLogItem }
      })
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => formatLogItem.calledOnce)
      ).to.eventually.equal(false)
    })
  })

  describe('#options.createLogGroup', () => {
    it('creates the log group', () => {
      const client = createClient({
        clientOptions: { createLogGroup: true }
      })
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => client._client.send.callCount)
      ).to.eventually.equal(3)
    })

    it('does not throw if the log group already exists', () => {
      const client = createClient({
        clientOptions: { createLogGroup: true },
        groupErrorCode: 'ResourceAlreadyExistsException'
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.fulfilled
    })

    it('throws if another error occurs', () => {
      const client = createClient({
        clientOptions: { createLogGroup: true },
        groupErrorCode: 'UnicornDoesNotExistException'
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.rejected
    })
  })

  describe('#options.createLogStream', () => {
    it('creates the log stream', () => {
      const client = createClient({
        clientOptions: { createLogStream: true }
      })
      const batch = createBatch(1)
      return expect(
        client.submit(batch).then(() => client._client.send.callCount)
      ).to.eventually.equal(3)
    })

    it('does not throw if the log stream already exists', () => {
      const client = createClient({
        clientOptions: { createLogStream: true },
        streamErrorCode: 'ResourceAlreadyExistsException'
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.fulfilled
    })

    it('throws if another error occurs', () => {
      const client = createClient({
        clientOptions: { createLogStream: true },
        streamErrorCode: 'UnicornDoesNotExistException'
      })
      const batch = createBatch(1)
      return expect(client.submit(batch)).to.be.rejected
    })
  })
})
