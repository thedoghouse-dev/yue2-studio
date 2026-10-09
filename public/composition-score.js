const $ = id => document.getElementById(id);
export function setupCompositionScore({getStudio,markDirty,renderEngine}) {
  let source='',version=0,loading=false,optionSignature='';
  function render() {
    const studio=getStudio();
    const scores=[...(studio?.transcriptions??[]).filter(s=>s.hasScore).map(s=>({value:`transcription:${s.id}`,title:`Sheet music · ${s.title}`})),...(studio?.songs??[]).filter(s=>s.hasScore).map(s=>({value:`song:${s.id}`,title:`Song score · ${s.title}`}))];
    const signature=JSON.stringify(scores);
    if(optionSignature!==signature){
      optionSignature=signature;$('composition-score').replaceChildren(new Option('Compose new music',''),new Option('Paste sheet music','custom'),...scores.map(s=>new Option(s.title,s.value)));
    }
    if(source && source!=='custom' && !scores.some(s=>s.value===source))source='custom';
    $('composition-score').value=source;
    $('composition-score-details').hidden=!source;
    $('abc').required=Boolean(source);
    const direct=document.querySelector('input[name="mode"][value="off"]');direct.disabled=Boolean(source);
    if(source&&direct.checked)document.querySelector('input[name="mode"][value="full"]').checked=true;
    $('composition-score-status').textContent=loading?'Loading the selected sheet music…':source?($('scoreUse').value==='motif'?'YuE2 will use this score as a motif with development guidance. Set a Target length to continue beyond a short tune.':'YuE2 will follow this supplied score with your lyrics and style.'):'YuE2 will compose a new melody and accompaniment.';
    $('abc').readOnly=loading;
    $('abc').setCustomValidity(loading?'Wait for the sheet music to finish loading.':'');
    renderEngine();
  }
  $('composition-score').addEventListener('change',async()=>{
    const key=$('composition-score').value,request=++version;source=key;loading=false;$('composition-score-error').hidden=true;
    if(!key){$('abc').value='';render();markDirty();return;}
    if(key==='custom'){render();$('composition-score-details').querySelectorAll('details').forEach(details => details.open = true);markDirty();$('abc').focus();return;}
    loading=true;$('abc').value='';render();
    try {
      const [kind,id]=key.split(':');const res=await fetch(`/api/${kind==='song'?'songs':'transcriptions'}/${id}/score`);
      if(!res.ok)throw new Error('Could not load that score. Select it again to retry.');
      const abc=await res.text();if(request!==version)return;
      if(!abc.trim()||abc.length>30000)throw new Error('This score is empty or too large. Choose another score.');
      $('abc').value=abc;
    }catch(error){if(request!==version)return;$('composition-score-error').textContent=error.message;$('composition-score-error').hidden=false;}
    finally{if(request===version){loading=false;render();markDirty();}}
  });
  $('abc').addEventListener('input',()=>{source='custom';render();markDirty();});
  $('scoreUse').addEventListener('change',render);
  return {render,source:()=>source,pending:()=>loading,load(value){
    if(value.abc===undefined)return;
    version++;loading=false;source=value.abc?.trim()?(value.scoreSource||'custom'):'';$('composition-score-error').hidden=true;render();
  }};
}
