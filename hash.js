const sjcl = require("sjcl");

function get_hash_string(input){
    return sjcl.codec.hex.fromBits(get_hash_bytes(input));
}

function get_hash_bytes(input){
    return sjcl.hash.sha256.hash(input);
}

function check_hash(hash){
    return hash.slice(0,5) === "00000";
}

exports.get_hash_string = get_hash_string;
exports.check_hash = check_hash;
