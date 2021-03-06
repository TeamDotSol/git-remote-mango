var async = require('async')
var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')
var ipfsAPI = require('ipfs-api')
var ipfs = ipfsAPI('localhost', '5001', { protocol: 'http' })
var Web3 = require('web3')
var rlp = require('rlp')
var ethUtil = require('ethereumjs-util')
var snapshot = require('./snapshot.js')
var repoABI = require('./OrganizationABI.json')
var _ = require('lodash');
var SolidityFunction = require('web3/lib/web3/function');

function gitHash (obj, data) {
  var hasher = crypto.createHash('sha1')
  hasher.update(obj.type + ' ' + obj.length + '\0')
  hasher.update(data)
  return hasher.digest('hex')
}

function ipfsPut (buf, enc, cb) {
  ipfs.object.put(buf, { enc }, function (err, node) {
    if (err) {
      console.error(`IPFS PUT Error: ${err}`)
      return cb(err)
    }

    cb(null, node.toJSON().Hash)
  })
}

function ipfsGet (key, cb) {
  ipfs.object.get(key, { enc: 'base58' }, function (err, node) {
    if (err) {
      console.error(`IPFS GET Error: ${err}`)
      return cb(err)
    }

    cb(null, node.toJSON().Data)
  })
}

module.exports = Repo

function Repo (orgName, repoName, user) {
    this.fromAddress = process.env.ADDRESS
    this.privateKey = process.env.PRIVATE_KEY
    this.orgName = orgName
    this.repoName = repoName
    this.web3 = new Web3(new Web3.providers.HttpProvider('https://rinkeby.infura.io/AQLPHGoZNh6Ktd33vkIg'))

    this.repoContract = this.web3.eth.contract(repoABI).at(orgName)
}

Repo.prototype._loadObjectMap = function (cb) {
  var self = this
  self._objectMap = {}
  self.snapshotGetAll(function (err, res) {
    if (err) return cb(err)

    async.each(res, function (item, cb) {
      ipfsGet(item, function (err, data) {
        if (err) return cb(err)
        Object.assign(self._objectMap, snapshot.parse(data))
        cb()
      })
    }, function (err) {
      cb(err)
    })
  })
}

Repo.prototype._ensureObjectMap = function (cb) {
  if (this._objectMap === undefined) {
    this._loadObjectMap(cb)
  } else {
    cb()
  }
}

Repo.prototype.snapshotAdd = function (hash, cb) {
  this.repoContract.addSnapshot(hash, cb)
}

Repo.prototype.snapshotGetAll = function (cb) {
  var count = this.repoContract.snapshotCount().toNumber()
  var snapshots = []

  for (var i = 0; i < count; i++) {
    snapshots.push(this.repoContract.getSnapshot(i))
  }

  cb(null, snapshots)
}

Repo.prototype.contractGetRef = function (ref, cb) {
  // this.repoContract.getRef(ref, cb)
}

Repo.prototype.contractSetRef = function (ref, hash, cb) {
  // this.repoContract.setRef(ref, hash, cb)
}

Repo.prototype.contractAllRefs = function (cb) {
  // var refcount = this.repoContract.refCount().toNumber()

  var refs = {}
  // for (var i = 0; i < refcount; i++) {
  //   var key = this.repoContract.refName(i)
  //   refs[key] = this.repoContract.getRef(key)
  // }

  cb(null, refs)
}

Repo.prototype.refs = function (prefix) {
  // var refcount = this.repoContract.refCount().toNumber()

  var refs = {}
  // for (var i = 0; i < refcount; i++) {
  //   var key = this.repoContract.refName(i)
  //   refs[key] = this.repoContract.getRef(key)
  // }

  var refNames = Object.keys(refs)
  i = 0
  return function (abort, cb) {
    if (abort) return
    if (i >= refNames.length) return cb(true)
    var refName = refNames[i++]
    cb(null, {
      name: refName,
      hash: refs[refName]
    })
  }
}

// FIXME: this is hardcoded for HEAD -> master
Repo.prototype.symrefs = function (a) {
  var i = 0
  return function (abort, cb) {
    if (abort) return
    if (i > 0) return cb(true)
    i++
    cb(null, {
      name: 'HEAD',
      ref: 'refs/heads/master'
    })
  }
}

Repo.prototype.hasObject = function (hash, cb) {
  var self = this

  this._ensureObjectMap(function () {
    cb(null, hash in self._objectMap)
  })
}

Repo.prototype.getObject = function (hash, cb) {
  var self = this

  this._ensureObjectMap(function (err) {
    if (err) return cb(err)

    if (!self._objectMap[hash]) {
      return cb('Object not present with key ' + hash)
    }

    ipfsGet(self._objectMap[hash], function (err, data) {
      if (err) return cb(err)

      var res = rlp.decode(data)

      return cb(null, {
        type: res[0].toString(),
        length: parseInt(res[1].toString(), 10),
        read: pull.once(res[2])
      })
    })
  })
}

Repo.prototype.update = async function (readRefUpdates, readObjects, cb) {
    var done = multicb({pluck: 1})
    var self = this

    if (readRefUpdates) {
        var doneReadingRefs = done()
        var ref
        var hash

        readRefUpdates(null, async function next (end, update) {
          if (end) {
            return doneReadingRefs(end === true ? null : end)
          }

          ref = update.name
          hash = update.new
        })
    }

    if (readObjects) {
    var doneReadingObjects = function () {
      ipfsPut(snapshot.create(self._objectMap), null, function (err, ipfsHash) {
        if (err) {
          return done(err)
        }

        console.error(ipfsHash, hash, self.repoName, ref)
        hash = self.web3.fromAscii(hash)
        repoName = self.web3.fromAscii(self.repoName)
        ref = self.web3.fromAscii(ref)
        sendFunction('commit', [hash, ipfsHash, repoName, ref], self.privateKey, self.fromAddress, self.orgName, self.web3, function (err, results) {
            if (err) {
                console.error(`Commit Error: ${err}`)
            } else {
                console.error(`Commit Success: ${results}`)
                done()
            }
        })
      })
    }

    self._objectMap = self._objectMap || {}

    readObjects(null, function next (end, object) {
        if (end) {
        return doneReadingObjects(end === true ? null : end)
      }
      pull(
        object.read,
        pull.collect(function (err, bufs) {
          if (err) {
            return doneReadingObjects(err)
          }

          var buf = Buffer.concat(bufs)
          var hash = gitHash(object, buf)

          var data = rlp.encode([ ethUtil.toBuffer(object.type), ethUtil.toBuffer(object.length.toString()), buf ])

          ipfsPut(data, null, function (err, ipfsHash) {
            if (err) {
              return doneReadingObjects(err)
            }

            console.error('piece', ipfsHash)

            self._objectMap[hash] = ipfsHash
            readObjects(null, next)
          })
        })
      )
    })
  }

  done(function (err) {
    if (err) {
      return cb(err)
    }
    cb()
  })
}

function sendFunction (functionName, payload, privateKey, address, contractAddress, web3, callback) {
    var solidityFunction = new SolidityFunction('', _.find(repoABI, { name: functionName }), '');
    const txhash = solidityFunction.toPayload(payload).data

    const key = new Buffer(privateKey, 'hex')
    const balance = web3.eth.getBalance(address)
    console.error('balance', balance.toString())

    const transaction = {
        data: txhash,
        from: address,
        to: contractAddress,
        gasPrice: 20000000000,
        gasLimit: 2000000,
        nonce: web3.eth.getTransactionCount(address)
    }

    const Tx = require('ethereumjs-tx')
    var tx = new Tx(transaction)

    tx.sign(key)

    var stx = tx.serialize();
    web3.eth.sendRawTransaction('0x' + stx.toString('hex'), function (err, results) {
        if (err) {
            callback(err, null)
        } else {
            callback(null, results)
        }
    });
}
