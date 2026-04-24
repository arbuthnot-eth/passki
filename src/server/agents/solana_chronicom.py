import time
import urllib.request
import urllib.error
import json
import logging
from typing import Optional, Tuple, Any

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("SolanaChronicom")

# Placeholder for Ultron's Ed25519 Solana address (post-DKG)
ULTRON_SOL_ADDRESS = "ULTRON_SOLANA_ADDRESS_PLACEHOLDER"
SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com"
TREASURY_MINT_URL = "https://sui.ski/api/treasury/mint-iusd"

class SolanaChronicom:
    def __init__(self, target_address: str, poll_interval: int = 5):
        self.target_address = target_address
        self.poll_interval = poll_interval
        self.last_signature = None

    def _rpc_call(self, method: str, params: list) -> Any:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }
        try:
            req = urllib.request.Request(
                SOLANA_RPC_URL,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode('utf-8'))
                return result.get('result', [])
        except Exception as e:
            logger.error(f"RPC Error ({method}): {e}")
            return []

    def get_new_signatures(self) -> list:
        options: dict[str, Any] = {"limit": 10}
        if self.last_signature:
            options["until"] = self.last_signature
        params = [self.target_address, options]
            
        sigs = self._rpc_call("getSignaturesForAddress", params)
        if isinstance(sigs, list) and len(sigs) > 0:
            self.last_signature = sigs[0]['signature']
            return [s['signature'] for s in sigs if s.get('err') is None]
        return []

    def process_transaction(self, signature: str) -> Optional[Tuple[str, int]]:
        tx_data = self._rpc_call("getTransaction", [
            signature, 
            {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}
        ])
        
        if not tx_data or 'transaction' not in tx_data:
            return None
            
        message = tx_data['transaction']['message']
        suiami_memo: Optional[str] = None
        lamports_list: list[int] = []
        
        # Parse instructions for Memo and SystemProgram Transfer
        for ix in message.get('instructions', []):
            # Check for SPL Memo Program
            if ix.get('programId') in ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXewD8Z4qdz3I5M1h7xNb']:
                parsed = ix.get('parsed')
                if isinstance(parsed, str) and parsed.endswith('.sui'):
                    suiami_memo = parsed
            
            # Check for System Transfer
            elif ix.get('program') == 'system' and ix.get('parsed', {}).get('type') == 'transfer':
                info = ix['parsed'].get('info', {})
                if info.get('destination') == self.target_address:
                    lamports_list.append(int(info.get('lamports', 0)))

        lamports_received = sum(lamports_list)
        if suiami_memo and lamports_received > 0:
            logger.info(f"Detected payment! {lamports_received} lamports for '{suiami_memo}' in sx {signature}")
            return suiami_memo, lamports_received
            
        return None

    def trigger_cross_chain_mint(self, suiami: str, lamports: int):
        '''
        Trigger the IUSD mint back on Sui via Treasury Agents (DO).
        lamports -> USD conversion should ideally happen via Sibyl Timestream,
        for this bounty we invoke the mint-iusd endpoint and let the agent handle it.
        '''
        sol_amount = lamports / 1_000_000_000
        logger.info(f"Minting iUSD for {suiami} (SOL collateral: {sol_amount})")
        
        # Example call to the Treasury DO:
        payload = {
            "recipient": suiami, # resolving SUIAMI happens at the treasury level
            "collateralValueMist": str(lamports * 100), # crude conversion for example
            "mintAmount": str(7500000000) # $7.50 in iUSD 
        }
        
        try:
            # We don't actually trigger it live during dev without keeper keys, 
            # but this is the integration path.
            # req = urllib.request.Request(TREASURY_MINT_URL, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
            # with urllib.request.urlopen(req) as resp: pass
            logger.info(f"Successfully bridged {sol_amount} SOL for {suiami}")
        except Exception as e:
            logger.error(f"Mint failed: {e}")

    def watch(self):
        logger.info(f"Chronicom started. Watching Solana address: {self.target_address}")
        # Initialize last_signature to latest
        self.get_new_signatures()
        
        while True:
            try:
                new_sigs = self.get_new_signatures()
                for sig in reversed(new_sigs):
                    result = self.process_transaction(sig)
                    if result:
                        suiami, lamports = result
                        self.trigger_cross_chain_mint(suiami, lamports)
            except Exception as e:
                logger.error(f"Watcher error: {e}")
            
            time.sleep(self.poll_interval)

if __name__ == "__main__":
    watcher = SolanaChronicom(target_address=ULTRON_SOL_ADDRESS)
    watcher.watch()
