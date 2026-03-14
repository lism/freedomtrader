// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract VanityDeployer {
    event Deployed(address addr);

    function deploy2(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        assembly {
            let ptr := mload(0x40)
            calldatacopy(ptr, initCode.offset, initCode.length)
            addr := create2(0, ptr, initCode.length, salt)
            if iszero(addr) { revert(0, 0) }
        }
        emit Deployed(addr);
    }

    function getDeployed(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), salt, initCodeHash
        )))));
    }
}
