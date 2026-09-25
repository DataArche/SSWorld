import {createTrafficController} from './traffic-motion.mjs';
import {createParkController} from './park-motion.mjs';
export function createHostInterfaces(api){return {Traffic:createTrafficController(api),Park:createParkController(api)};}
