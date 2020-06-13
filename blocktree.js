const { get_hash_string, check_hash } = require("./hash.js")

const ROOT_HASH = "0000000000000000000000000000000000000000000000000000000000000000";


//any hash collisions here will cause horrible and impossible-to-debug errors.
//there aren't supposed to be any hash collisions though so hopefully it's ok :)
class BlockTree {
    //applies an array of transactions to a state and returns the resulting state.
    //does not mutate the original state.
    applyTransactions(transactions, state = this.states[this.bestLeaf]) {
        //deep copy (unironically very efficient)
        let ret = JSON.parse(JSON.stringify(state));
        for (let t of transactions) {
            if (t.Type !== "TRANSFER") {
                return false;
            }
            ret[t.ToID] = ret[t.ToID] || 1000;
            ret[t.FromID] = ret[t.FromID] || 1000;
            ret[t.MinerID] = ret[t.MinerID] || 1000;
            if (t.Value <= t.MiningFee) {
                return false;
            }
            ret[t.ToID] += t.Value - t.MiningFee;
            ret[t.FromID] -= t.Value;
            ret[t.MinerID] += t.MiningFee;
            if (ret[t.FromID] < 0) {
                return false;
            }
        }
        return ret;
    }

    getState(hash) {
        if (this.states[hash]) {
            return this.states[hash];
        }
        else {
            let block = this.blocks[hash];
            if (!block) {
                return false;
            }
            //this might cause a stack overflow later but i dont care right now
            return this.applyTransactions(block.transactions, this.getState(block.PrevHash));
        }
    }
    getHeight(hash) {
        if (hash === ROOT_HASH) {
            return 0;
        }
        else {
            if (this.blocks[hash]) {
                return this.blocks[hash].BlockID;
            }
            else {
                return -1;
            }
        }
    }
    has(hash) {
        return hash === ROOT_HASH || this.blocks[hash];
    }
    //attempts to add a block to the tree. doesn't do anything if it can't connect.
    add(block, hash = null) {
        if (!(block.PrevHash === ROOT_HASH || this.blocks[block.PrevHash])) {
            console.log(`/ ${hash} rejected (no parent block found)`);
            return false;
        }

        const height = block.BlockID;
        if (height !== this.getHeight(block.PrevHash)) {
            console.log(`/ ${hash} rejected (incorrect height)`);
            return false;
        }

        hash = hash || get_hash_string(JSON.parse(block));
        if (!check_hash(hash)) {
            console.log(`/ ${hash} rejected from tree (bad hash)`);
            return false;
        }

        for (let t of block.Transactions) {
            if (this.transactionUUIDs.has(t.UUID)) {
                console.log(`/ ${hash} rejected from tree (duplicate transaction)`);
                return false;
            }
        }
        const state = this.applyTransactions(block.Transactions, this.getState(block.PrevHash));
        if (!state) {
            console.log(`/ ${hash} rejected from tree (invalid transaction)`);
            return false;
        }

        for (let t of block.Transactions) {
            this.transactionUUIDs.add(t.UUID);
        }

        if (height > this.bestHeight || (height === this.bestHeight && hash < this.bestLeaf)) {
            this.bestLeaf = hash;
            this.bestHeight = height;
        }
        console.log(`+ ${hash} added to tree (height ${height})`);
        return height;
    }
    constructor() {
        //hash -> block
        this.blocks = {};
        //hash -> state
        this.states = {};

        this.bestLeaf = ROOT_HASH;
        this.bestHeight = 0;

        this.transactionUUIDs = new Set();
    }
}

exports.BlockTree = BlockTree;