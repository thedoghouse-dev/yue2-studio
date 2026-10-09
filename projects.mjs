import { randomUUID } from 'node:crypto';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function createProjects({db,save,onRemove=()=>{}}){
  db.projects??=[];
  const label=value=>{if(typeof value!=='string'||!value.trim()||value.length>80||value.includes('\0'))fail('Give the project a name up to 80 characters.');return value.trim();};
  const validProject=value=>{if(value==null)return '';if(typeof value!=='string')fail('Choose a project or Unassigned.');if(value&&!db.projects.some(p=>p.id===value&&!p.archived))fail('Project not found.',404);return value;};
  const unique=(name,id)=>{if(db.projects.some(p=>!p.archived&&p.id!==id&&p.name.toLowerCase()===name.toLowerCase()))fail('A project with that name already exists.');};
  const list=()=>db.projects.filter(p=>!p.archived).map(p=>({...p,songCount:db.songs.filter(s=>!s.deletedAt&&s.projectId===p.id).length}));
  return {list,validProject,async handle(req,res,route,{body,send}){
    if(route==='/api/projects'&&req.method==='GET'){send(res,200,{projects:list()});return true;}
    if(route==='/api/projects'&&req.method==='POST'){
      const input=await body(req),name=label(input.name);unique(name);
      const project={id:randomUUID(),name,createdAt:new Date().toISOString()};db.projects.push(project);save();send(res,201,project);return true;
    }
    if(route==='/api/projects/move'&&req.method==='POST'){
      const input=await body(req),ids=input.songIds,creating=input.newProjectName!==undefined;
      const name=creating?label(input.newProjectName):null;let projectId=creating?'':validProject(input.projectId);if(creating)unique(name);
      if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)fail('Select between one and 500 different songs.');
      const songs=ids.map(id=>{const song=db.songs.find(s=>s.id===id&&!s.deletedAt);if(!song)fail('One of the selected songs no longer exists.',404);return song;});
      if(creating){projectId=randomUUID();db.projects.push({id:projectId,name,createdAt:new Date().toISOString()});}
      for(const song of songs)song.projectId=projectId;
      save();send(res,200,{moved:songs.length,projectId});return true;
    }
    const match=/^\/api\/projects\/([a-f0-9-]{36})$/.exec(route);
    if(match){
      const project=db.projects.find(p=>p.id===match[1]&&!p.archived);if(!project)fail('Project not found.',404);
      if(req.method==='PATCH'){const name=label((await body(req)).name);unique(name,project.id);project.name=name;save();send(res,200,project);return true;}
      if(req.method==='DELETE'){
        project.archived=true;onRemove(project.id);
        for(const song of db.songs)if(song.projectId===project.id)song.projectId='';
        if(db.draft?.projectId===project.id)db.draft.projectId='';
        save();send(res,200,{removed:true,songsPreserved:true});return true;
      }
    }
    return false;
  }};
}
