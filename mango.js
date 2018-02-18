var async = require('async')
var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')
var IPFS = require('ipfs')
var ipfs = new IPFS()
var Web3 = require('web3')
var rlp = require('rlp')
var ethUtil = require('ethereumjs-util')
var snapshot = require('./snapshot.js')
var repoABI = require('./MangoRepoABI.json')

function gitHash (obj, data) {
  var hasher = crypto.createHash('sha1')
  hasher.update(obj.type + ' ' + obj.length + '\0')
  hasher.update(data)
  return hasher.digest('hex')
}

function ipfsPut (buf, enc, cb) {
  ipfs.object.put(buf, { enc }, function (err, node) {
    if (err) {
      return cb(err)
    }

    cb(null, node.toJSON().Hash)
  })
}

function ipfsGet (key, cb) {
  ipfs.object.get(key, { enc: 'base58' }, function (err, node) {
    if (err) {
      return cb(err)
    }

    cb(null, node.toJSON().Data)
  })
}

module.exports = Repo

function Repo (address, user) {
    this.address = address
    this.privateKey = process.env.PRIVATE_KEY
    this.web3 = new Web3(new Web3.providers.HttpProvider('https://rinkeby.infura.io/AQLPHGoZNh6Ktd33vkIg'))

    this.repoContract = this.web3.eth.contract(repoABI).at(address)
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
  this.repoContract.getRef(ref, cb)
}

Repo.prototype.contractSetRef = function (ref, hash, cb) {
  this.repoContract.setRef(ref, hash, cb)
}

Repo.prototype.contractAllRefs = function (cb) {
  var refcount = this.repoContract.refCount().toNumber()

  var refs = {}
  for (var i = 0; i < refcount; i++) {
    var key = this.repoContract.refName(i)
    refs[key] = this.repoContract.getRef(key)
  }

  cb(null, refs)
}

Repo.prototype.refs = function (prefix) {
  var refcount = this.repoContract.refCount().toNumber()

  var refs = {}
  for (var i = 0; i < refcount; i++) {
    var key = this.repoContract.refName(i)
    refs[key] = this.repoContract.getRef(key)
  }

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

Repo.prototype.update = function (readRefUpdates, readObjects, cb) {
  var done = multicb({pluck: 1})
  var self = this

    if (readObjects) {
    var doneReadingObjects = function () {
      ipfsPut(snapshot.create(self._objectMap), null, function (err, ipfsHash) {
        if (err) {

          return done(err)
        }

        self.snapshotAdd(ipfsHash, function () {
          done()
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

            self._objectMap[hash] = ipfsHash
            readObjects(null, next)
          })
        })
      )
    })
  }

  if (readRefUpdates) {
    var doneReadingRefs = done()

    readRefUpdates(null, function next (end, update) {
      if (end) {
        return doneReadingRefs(end === true ? null : end)
      }

      var ref = self.repoContract.getRef(update.name, {gas: 20000000})
      if (typeof(ref) === 'string' && ref.length === 0) {
        ref = null
      }

      if (update.old !== ref) {
        return doneReadingRefs(new Error(
          'Ref update old value is incorrect. ' +
          'ref: ' + update.name + ', ' +
          'old in update: ' + update.old + ', ' +
          'old in repo: ' + ref
        ))
      }

      if (update.new) {
          self.repoContract.setRef(update.name, update.new, { gas: 20000000 })
      } else {
          self.repoContract.deleteRef(update.name, { gas: 20000000 })
      }
      console.error('after update')
      readRefUpdates(null, next)
    })
  }

  done(function (err) {
    if (err) {
      return cb(err)
    }
    cb()
  })
}

function sendFunction (functionName, payload, callback) {
    var solidityFunction = new SolidityFunction('', _.find(repoABI, { name: functionName }), '');
    const txhash = solidityFunction.toPayload(payload).data

    const key = new Buffer(privateKey, 'hex')
    const balance = web3.eth.getBalance(address)
    console.log('balance', balance.toString())

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
