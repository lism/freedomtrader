// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {FreedomHook} from "../src/FreedomHook.sol";

contract DeployFreedomHook is Script {
    address constant DEFAULT_BSC_CL_POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;

    function run() public {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address sender = vm.addr(privateKey);
        address hookOwner = vm.envOr("HOOK_OWNER", sender);
        address clPoolManager = vm.envOr("CL_POOL_MANAGER", DEFAULT_BSC_CL_POOL_MANAGER);

        vm.startBroadcast(privateKey);

        ICLPoolManager poolManager = ICLPoolManager(clPoolManager);

        console2.log("deployer:", sender);
        console2.log("hookOwner:", hookOwner);
        console2.log("clPoolManager:", clPoolManager);

        FreedomHook hook = new FreedomHook(poolManager, hookOwner);
        console2.log("FreedomHook:", address(hook));
        console2.log("bitmap:", uint256(hook.getHooksRegistrationBitmap()));

        vm.stopBroadcast();
    }
}
